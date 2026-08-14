"""Evidence bundles and attestations: results that can be checked afterwards.

An attestation binds a verdict to everything it was derived from — the frozen
contract, the content revision, the capture, the artifact digests, the check
results, the policy, the cost. Change any of them and the binding breaks.

It is a *hash* binding by default, and says so. Hashing proves the bundle has
not been edited since it was written; it does not prove who wrote it, and this
module never uses the word "signed" for an unsigned bundle. Ed25519 signing is
available when ``cryptography`` is installed (``pip install watch-skill[attest]``)
and is the only thing that sets ``signature``.
"""
from __future__ import annotations

import hashlib
import json
import platform
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Protocol

from pydantic import BaseModel, Field

from watch_skill.errors import WatchSkillError
from watch_skill.verify.checks import CheckResult
from watch_skill.verify.contract import Assurance, CheckStatus, VerificationContract

ATTESTATION_SCHEMA_VERSION = 1


class AttestationError(WatchSkillError):
    """An attestation did not match what it claims to describe."""

    default_code = "verify.attestation_invalid"


def canonical_bytes(payload: dict[str, Any]) -> bytes:
    """The one serialization every digest in this module is taken over."""
    return json.dumps(
        payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=str
    ).encode("utf-8")


def digest_bytes(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


def digest_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1 << 20):
            digest.update(chunk)
    return "sha256:" + digest.hexdigest()


# --- signing ----------------------------------------------------------------


class Signer(Protocol):
    """Turns canonical bytes into a signature. The extension point."""

    algorithm: str

    def sign(self, payload: bytes) -> str:
        ...

    def public_key(self) -> str:
        ...


class Ed25519Signer:
    """Real Ed25519 signing, when ``cryptography`` is available.

    Constructing this without the dependency raises rather than degrading
    quietly to a hash — a caller that asked for a signature must not be told
    it got one.
    """

    algorithm = "ed25519"

    def __init__(self, private_key_bytes: bytes) -> None:
        try:
            from cryptography.hazmat.primitives.asymmetric.ed25519 import (  # noqa: PLC0415
                Ed25519PrivateKey,
            )
        except ImportError as exc:
            raise AttestationError(
                "Ed25519 signing needs the optional cryptography dependency",
                code="verify.signing_unavailable",
                fix="pip install 'watch-skill[attest]', or leave attestations "
                "unsigned — they are still hash-bound and tamper-evident",
            ) from exc
        self._key = Ed25519PrivateKey.from_private_bytes(private_key_bytes)

    def sign(self, payload: bytes) -> str:
        return self._key.sign(payload).hex()

    def public_key(self) -> str:
        from cryptography.hazmat.primitives import serialization  # noqa: PLC0415

        return self._key.public_key().public_bytes(
            encoding=serialization.Encoding.Raw,
            format=serialization.PublicFormat.Raw,
        ).hex()


def signing_available() -> bool:
    try:
        import cryptography.hazmat.primitives.asymmetric.ed25519  # noqa: F401,PLC0415
    except ImportError:
        return False
    return True


# --- the bundle -------------------------------------------------------------


class ArtifactRef(BaseModel):
    """One file the verdict rests on, and its digest at the time."""

    role: str
    path: str
    digest: str
    bytes: int = 0


class EvidenceBundle(BaseModel):
    """Everything one verified run produced, in a re-checkable form."""

    schema_version: int = ATTESTATION_SCHEMA_VERSION
    run_id: str
    created_at: str = Field(
        default_factory=lambda: datetime.now(UTC).isoformat(timespec="seconds")
    )
    contract_id: str
    contract_digest: str
    interaction_script_digest: str | None = None
    loop_id: str | None = None
    iteration: int | None = None
    source_alias: str | None = None
    revision_id: str | None = None
    content_digest: str | None = None
    capture_digest: str | None = None
    artifacts: list[ArtifactRef] = Field(default_factory=list)
    check_results: list[CheckResult] = Field(default_factory=list)
    advisory_findings: list[dict[str, Any]] = Field(default_factory=list)
    verdict: str = "inconclusive"
    assurance: str = Assurance.VISUAL_ADVISORY.value
    limitations: list[str] = Field(default_factory=list)
    policy_snapshot: dict[str, Any] = Field(default_factory=dict)
    cost: dict[str, Any] = Field(default_factory=dict)
    tools: dict[str, str] = Field(default_factory=dict)
    started_at: str = ""
    ended_at: str = ""

    def canonical(self) -> bytes:
        return canonical_bytes(self.model_dump(mode="json"))

    def digest(self) -> str:
        return digest_bytes(self.canonical())


class Attestation(BaseModel):
    """The binding: a bundle digest, and optionally a signature over it."""

    schema_version: int = ATTESTATION_SCHEMA_VERSION
    bundle_digest: str
    verdict: str
    assurance: str
    contract_digest: str
    created_at: str = Field(
        default_factory=lambda: datetime.now(UTC).isoformat(timespec="seconds")
    )
    host: dict[str, str] = Field(default_factory=dict)
    # Absent means exactly that: hash-bound, unsigned, and no claim of
    # authorship. `signature_status` says so in words for anyone reading the
    # JSON without the docs.
    signature: str | None = None
    signature_algorithm: str | None = None
    public_key: str | None = None
    signature_status: str = "unsigned_hash_bound"

    def verify(self, bundle: EvidenceBundle) -> None:
        """Raise unless this attestation still describes this exact bundle."""
        actual = bundle.digest()
        if actual != self.bundle_digest:
            raise AttestationError(
                "the evidence bundle does not match its attestation",
                code="verify.attestation_tampered",
                fix="the evidence, the contract, or a check result changed "
                "after the run — re-run the verification; do not trust this "
                "verdict",
                details={"recorded": self.bundle_digest, "actual": actual},
            )
        if self.verdict != bundle.verdict or self.assurance != bundle.assurance:
            raise AttestationError(
                "the attested verdict does not match the bundle's verdict",
                code="verify.attestation_mismatch",
                fix="re-run the verification; the attestation was written "
                "against a different result",
                details={"attested": self.verdict, "bundle": bundle.verdict},
            )
        if self.signature is not None:
            self._verify_signature()

    def _verify_signature(self) -> None:
        try:
            from cryptography.exceptions import InvalidSignature  # noqa: PLC0415
            from cryptography.hazmat.primitives.asymmetric.ed25519 import (  # noqa: PLC0415
                Ed25519PublicKey,
            )
        except ImportError as exc:
            raise AttestationError(
                "this attestation is signed but cryptography is not installed",
                code="verify.signature_uncheckable",
                fix="pip install 'watch-skill[attest]' to check the signature, "
                "or treat this attestation as unverified",
            ) from exc
        key = Ed25519PublicKey.from_public_bytes(bytes.fromhex(self.public_key or ""))
        try:
            key.verify(bytes.fromhex(self.signature or ""),
                       self.bundle_digest.encode("utf-8"))
        except InvalidSignature as exc:
            raise AttestationError(
                "the attestation's signature is not valid",
                code="verify.signature_invalid",
                fix="do not trust this verdict; re-run the verification",
            ) from exc


def attest(bundle: EvidenceBundle, signer: Signer | None = None) -> Attestation:
    """Bind a bundle. Signs only when a signer is supplied."""
    attestation = Attestation(
        bundle_digest=bundle.digest(),
        verdict=bundle.verdict,
        assurance=bundle.assurance,
        contract_digest=bundle.contract_digest,
        host={"platform": platform.system(), "release": platform.release()},
    )
    if signer is None:
        return attestation
    return attestation.model_copy(update={
        "signature": signer.sign(attestation.bundle_digest.encode("utf-8")),
        "signature_algorithm": signer.algorithm,
        "public_key": signer.public_key(),
        "signature_status": f"signed_{signer.algorithm}",
    })


# --- deciding the verdict ---------------------------------------------------


def decide(
    contract: VerificationContract,
    results: list[CheckResult],
    backend_assurance: Assurance,
    advisory_findings: list[dict[str, Any]] | None = None,
) -> tuple[str, str, list[str]]:
    """(verdict, assurance, limitations) from the check results.

    The rules, in the order they apply:

    * a required check that failed is a ``fail``, whatever any model said;
    * a required check that could not run is ``inconclusive`` — never a pass;
    * a required check missing entirely is ``inconclusive``;
    * only when every required check passed is the verdict ``pass``.

    Advisory findings never change the verdict. They are recorded because
    "the model thought the spacing looked wrong" is worth a human's attention,
    and are kept out of the decision because it is not evidence of anything.
    """
    contract.verify_integrity()
    required = {check.id for check in contract.required_checks}
    by_id = {result.check_id: result for result in results}
    limitations: list[str] = []

    missing = sorted(required - set(by_id))
    for check_id in missing:
        limitations.append(f"required check {check_id!r} never ran")

    failed = [r for r in results if r.required and r.status is CheckStatus.FAIL]
    unresolved = [
        r for r in results
        if r.required and r.status in (CheckStatus.INCONCLUSIVE, CheckStatus.ERROR)
    ]
    for result in unresolved:
        limitations.append(f"required check {result.check_id!r}: {result.summary}")

    if failed:
        verdict = "fail"
    elif missing or unresolved:
        verdict = "inconclusive"
    elif not required:
        # Nothing deterministic was required, so nothing deterministic was
        # established. Advisory evidence alone cannot make this a pass.
        verdict = "inconclusive"
        limitations.append(
            "the contract carries no required deterministic check, so this run "
            "produced advisory visual evidence only"
        )
    else:
        verdict = "pass"

    assurance = (
        backend_assurance.value if required and not (missing or unresolved)
        else Assurance.VISUAL_ADVISORY.value
    )
    for finding in advisory_findings or []:
        limitations.append(
            f"advisory (not verified): {finding.get('description', '')[:160]}"
        )
    return verdict, assurance, limitations

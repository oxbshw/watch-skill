"""Deterministic verification: what decides whether an agent run succeeded.

The split this package exists to enforce:

* **perception** shows what happened — frames, OCR, transcript;
* **the critic** offers an opinion about it, which is advisory;
* **a contract's required checks** decide, and only they do;
* **an attestation** binds the verdict to everything it came from.

A run with no required checks does not produce a pass. It produces advisory
visual evidence and says so, because that is what it is.
"""
from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from watch_skill.config import get_settings
from watch_skill.errors import WatchSkillError
from watch_skill.verify.backends import get_verifier
from watch_skill.verify.checks import SUPPORTED_CHECK_TYPES, CheckContext, CheckResult
from watch_skill.verify.contract import (
    Assurance,
    Check,
    CheckStatus,
    ContractError,
    VerificationContract,
    assurance_at_least,
    merge_draft,
)
from watch_skill.verify.evidence import (
    ArtifactRef,
    Attestation,
    AttestationError,
    EvidenceBundle,
    Signer,
    attest,
    decide,
    digest_file,
    signing_available,
)

__all__ = [
    "ArtifactRef",
    "Assurance",
    "Attestation",
    "AttestationError",
    "Check",
    "CheckContext",
    "CheckResult",
    "CheckStatus",
    "ContractError",
    "EvidenceBundle",
    "SUPPORTED_CHECK_TYPES",
    "Signer",
    "VerificationContract",
    "assurance_at_least",
    "attest",
    "decide",
    "draft_contract",
    "load_run",
    "merge_draft",
    "run_dir",
    "signing_available",
    "verify_run",
]


def run_dir(run_id: str) -> Path:
    return get_settings().data_dir / "verifications" / run_id


def draft_contract(
    title: str,
    checks: list[dict[str, Any]],
    *,
    contract_id: str | None = None,
    created_by: str = "agent",
    required_assurance: Assurance = Assurance.ISOLATED_LOCAL,
    allowed_origins: list[str] | None = None,
    source_prompt: str = "",
) -> VerificationContract:
    """Build an unfrozen draft. Freeze it before the run it will judge.

    ``allowed_origins`` is the allowlist the network checks are bounded by. It
    belongs to the contract because the digest has to cover it: a permission
    handed in at run time is a permission the frozen agreement never made.
    """
    return VerificationContract(
        contract_id=contract_id or f"vc_{uuid.uuid4().hex[:12]}",
        title=title,
        created_by=created_by,
        checks=[Check.model_validate(item) for item in checks],
        required_assurance=required_assurance,
        allowed_origins=list(allowed_origins or []),
        source_prompt=source_prompt,
    )


def verify_run(
    contract: VerificationContract,
    *,
    working_dir: str | Path,
    allowed_roots: list[str] | None = None,
    allowed_origins: list[str] | None = None,
    evidence: dict[str, Any] | None = None,
    artifacts: list[tuple[str, Path]] | None = None,
    advisory_findings: list[dict[str, Any]] | None = None,
    isolated: bool = True,
    run_id: str | None = None,
    loop_id: str | None = None,
    iteration: int | None = None,
    source_alias: str | None = None,
    revision_id: str | None = None,
    content_digest: str | None = None,
    capture_path: Path | None = None,
    interaction_script: list[dict[str, Any]] | None = None,
    signer: Signer | None = None,
) -> tuple[EvidenceBundle, Attestation]:
    """Execute a frozen contract and write a tamper-evident bundle.

    Raises when the contract is not frozen or was modified after freezing:
    running an unfrozen contract would let the target move while it is being
    aimed at, which makes the whole exercise decorative.
    """
    contract.verify_integrity()
    if not assurance_at_least(
        _backend_assurance(isolated), contract.required_assurance
    ):
        raise ContractError(
            f"this contract requires {contract.required_assurance.value} but the "
            f"available backend only provides {_backend_assurance(isolated).value}",
            code="verify.assurance_unavailable",
            fix="lower required_assurance, or run the checks on a backend that "
            "provides the level you asked for — Watch Skill has no remote "
            "attested verifier, so remote_attested is never satisfiable here",
            details={"required": contract.required_assurance.value,
                     "available": _backend_assurance(isolated).value},
        )

    from watch_skill.policy import get_ledger, get_policy

    run_id = run_id or f"vr_{uuid.uuid4().hex[:12]}"
    started = datetime.now(UTC).isoformat(timespec="seconds")
    work = Path(working_dir).resolve()
    ctx = CheckContext(
        working_dir=str(work),
        allowed_roots=[str(Path(r).resolve()) for r in (allowed_roots or [work])],
        allowed_origins=allowed_origins or [],
        evidence=evidence or {},
    )

    backend = get_verifier(isolated=isolated)
    results = backend.run(contract.checks, ctx)
    verdict, assurance, limitations = decide(
        contract, results, backend.assurance, advisory_findings
    )

    refs = [
        ArtifactRef(role=role, path=str(path), digest=digest_file(path),
                    bytes=path.stat().st_size)
        for role, path in (artifacts or []) if Path(path).is_file()
    ]
    bundle = EvidenceBundle(
        run_id=run_id,
        contract_id=contract.contract_id,
        contract_digest=contract.digest or "",
        interaction_script_digest=_script_digest(interaction_script),
        loop_id=loop_id,
        iteration=iteration,
        source_alias=source_alias,
        revision_id=revision_id,
        content_digest=content_digest,
        capture_digest=digest_file(capture_path) if capture_path
        and Path(capture_path).is_file() else None,
        artifacts=refs,
        check_results=results,
        advisory_findings=advisory_findings or [],
        verdict=verdict,
        assurance=assurance,
        limitations=limitations,
        policy_snapshot=get_policy().to_dict(),
        cost=get_ledger().to_dict(),
        tools={"watch_skill": _version(), "backend": type(backend).__name__},
        started_at=started,
        ended_at=datetime.now(UTC).isoformat(timespec="seconds"),
    )
    attestation = attest(bundle, signer)
    _persist(run_id, contract, bundle, attestation)
    return bundle, attestation


def _backend_assurance(isolated: bool) -> Assurance:
    return Assurance.ISOLATED_LOCAL if isolated else Assurance.DETERMINISTIC_LOCAL


def _script_digest(script: list[dict[str, Any]] | None) -> str | None:
    """Freeze the interaction script too — a different script is a different run."""
    if not script:
        return None
    from watch_skill.verify.evidence import canonical_bytes, digest_bytes

    return digest_bytes(canonical_bytes({"script": script}))


def _version() -> str:
    from importlib.metadata import PackageNotFoundError, version  # noqa: PLC0415

    try:
        return version("watch-skill")
    except PackageNotFoundError:
        return "unknown"


def _persist(
    run_id: str,
    contract: VerificationContract,
    bundle: EvidenceBundle,
    attestation: Attestation,
) -> Path:
    directory = run_dir(run_id)
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "contract.json").write_text(
        contract.model_dump_json(indent=2), encoding="utf-8"
    )
    (directory / "evidence.json").write_text(
        bundle.model_dump_json(indent=2), encoding="utf-8"
    )
    (directory / "attestation.json").write_text(
        attestation.model_dump_json(indent=2), encoding="utf-8"
    )
    return directory


def load_run(run_id: str) -> tuple[VerificationContract, EvidenceBundle, Attestation]:
    """Read a persisted run back and re-check its binding.

    Reading is where tampering is caught: the attestation is verified against
    the bundle on the way out, so a hand-edited evidence.json raises instead of
    being reported as a verified pass.
    """
    directory = run_dir(run_id)
    if not (directory / "evidence.json").is_file():
        raise WatchSkillError(
            f"no verification run recorded under {run_id}",
            code="verify.run_not_found",
            fix="`watch-skill verify list` shows the runs on this machine",
            details={"run_id": run_id, "looked_in": str(directory)},
        )
    contract = VerificationContract.model_validate_json(
        (directory / "contract.json").read_text(encoding="utf-8")
    )
    bundle = EvidenceBundle.model_validate_json(
        (directory / "evidence.json").read_text(encoding="utf-8")
    )
    attestation = Attestation.model_validate_json(
        (directory / "attestation.json").read_text(encoding="utf-8")
    )
    attestation.verify(bundle)
    return contract, bundle, attestation


def list_runs() -> list[dict[str, Any]]:
    """Every recorded verification run, newest first."""
    root = get_settings().data_dir / "verifications"
    if not root.is_dir():
        return []
    out: list[dict[str, Any]] = []
    for directory in root.iterdir():
        path = directory / "evidence.json"
        if not path.is_file():
            continue
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        out.append({
            "run_id": data.get("run_id"),
            "contract_id": data.get("contract_id"),
            "verdict": data.get("verdict"),
            "assurance": data.get("assurance"),
            "created_at": data.get("created_at"),
        })
    return sorted(out, key=lambda r: r.get("created_at") or "", reverse=True)

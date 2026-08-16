"""Verification contracts: what "it worked" means, fixed before it is tried.

A contract is written and frozen *before* the run it judges. After freezing it
is immutable and identified by the digest of its canonical form, so an agent
cannot notice it is about to fail and quietly widen the target — which is the
failure mode any "the model decides if it passed" design has.

Natural language may propose a draft. The LLM's reading of it is never
authoritative: the structured checks are printed, frozen, and digested first,
and the run is judged against those.
"""
from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime
from enum import Enum
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator

from watch_skill.errors import WatchSkillError

CONTRACT_SCHEMA_VERSION = 1


class ContractError(WatchSkillError):
    """A contract was malformed, or mutated after it was frozen."""

    default_code = "verify.contract_invalid"


class CheckStatus(str, Enum):  # noqa: UP042 — matches SourceKind
    PASS = "pass"
    FAIL = "fail"
    INCONCLUSIVE = "inconclusive"
    ERROR = "error"


class Assurance(str, Enum):  # noqa: UP042 — matches SourceKind
    """How much a verdict is worth. Ordered weakest to strongest."""

    VISUAL_ADVISORY = "visual_advisory"
    """A model looked at pictures and formed an opinion."""

    DETERMINISTIC_LOCAL = "deterministic_local"
    """Deterministic checks ran, in this process, as this user."""

    ISOLATED_LOCAL = "isolated_local"
    """Deterministic checks ran in a separate, sanitized process."""

    REMOTE_ATTESTED = "remote_attested"
    """Checks ran on an independent machine and signed the result. Watch Skill
    does not implement this; the level exists so nothing else can claim it."""


_ORDER = [
    Assurance.VISUAL_ADVISORY,
    Assurance.DETERMINISTIC_LOCAL,
    Assurance.ISOLATED_LOCAL,
    Assurance.REMOTE_ATTESTED,
]


def assurance_at_least(actual: Assurance, required: Assurance) -> bool:
    return _ORDER.index(actual) >= _ORDER.index(required)


CheckType = Literal[
    "file_exists",
    "file_digest",
    "directory_manifest",
    "json_value",
    "json_schema",
    "sqlite_query",
    "http_request",
    "command_exit",
    "numeric_invariant",
    "visual_absent",
    # Oracles that read a running world rather than a file. Each one is
    # evaluated in the verifier process, read-only, against a target named in
    # the frozen contract — never against state the acting agent hands over.
    "browser_dom",
    "live_console",
    "live_evidence",
    "human_approval",
]


class Check(BaseModel):
    """One deterministic postcondition.

    ``required`` is the whole point of the field: an advisory check records an
    observation, a required check decides the verdict. A model may add
    advisory checks to a draft; it may not mark one required, and it may not
    weaken one that already is (see :meth:`VerificationContract.freeze`).
    """

    model_config = {"frozen": True, "extra": "forbid"}

    id: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_.:-]+$")
    type: CheckType
    required: bool = True
    description: str = ""
    # Per-type parameters, validated by the check implementation rather than
    # here, so adding a check type does not touch the contract model.
    params: dict[str, Any] = Field(default_factory=dict)
    timeout_seconds: float = Field(default=30.0, gt=0, le=600)

    @field_validator("params")
    @classmethod
    def _reject_untrusted_shapes(cls, value: dict[str, Any]) -> dict[str, Any]:
        """Refuse the shapes that would let content decide what runs.

        A command assembled from a string is a command an OCR line can rewrite.
        Commands are argv lists, always, and the worker never uses a shell.
        """
        command = value.get("command")
        if command is not None and not isinstance(command, list):
            raise ValueError(
                "command must be a list of arguments, never a string: a string "
                "would be shell-parsed and could be built from video content"
            )
        if isinstance(command, list) and not all(isinstance(a, str) for a in command):
            raise ValueError("every command argument must be a string")
        return value


class VerificationContract(BaseModel):
    """The frozen definition of success for one agent run."""

    model_config = {"extra": "forbid"}

    schema_version: int = CONTRACT_SCHEMA_VERSION
    contract_id: str
    title: str = ""
    created_by: str = "unknown"
    created_at: str = Field(default_factory=lambda: datetime.now(UTC).isoformat(timespec="seconds"))
    checks: list[Check] = Field(default_factory=list)
    required_assurance: Assurance = Assurance.DETERMINISTIC_LOCAL
    # Set by freeze(). A contract without them has not been frozen and cannot
    # be used to judge anything.
    frozen_at: str | None = None
    digest: str | None = None
    # The natural-language request a draft came from, kept for the record. It
    # is provenance, not policy: nothing reads it back to decide anything.
    source_prompt: str = ""

    # --- canonical form -----------------------------------------------------

    def canonical_bytes(self) -> bytes:
        """Deterministic serialization, excluding the digest itself.

        Sorted keys, no insignificant whitespace, UTF-8. Two processes that
        build the same contract must produce identical bytes or the digest
        means nothing.
        """
        data = self.model_dump(mode="json", exclude={"digest"})
        return json.dumps(
            data, sort_keys=True, separators=(",", ":"), ensure_ascii=False
        ).encode("utf-8")

    def compute_digest(self) -> str:
        return "sha256:" + hashlib.sha256(self.canonical_bytes()).hexdigest()

    # --- freezing -----------------------------------------------------------

    @property
    def frozen(self) -> bool:
        return self.frozen_at is not None and self.digest is not None

    def freeze(self, *, created_by: str | None = None) -> VerificationContract:
        """Fix this contract and stamp it. Freezing twice is an error.

        Returns a NEW frozen contract; the draft is left alone so the caller
        can keep editing a draft without ever mutating something already used
        to judge a run.
        """
        if self.frozen:
            raise ContractError(
                f"contract {self.contract_id} is already frozen",
                code="verify.contract_already_frozen",
                fix="derive a new revision with revise() instead of editing a "
                "frozen contract — a changed contract is a new contract",
                details={"contract_id": self.contract_id, "digest": self.digest},
            )
        if not self.checks:
            raise ContractError(
                "a contract with no checks cannot verify anything",
                code="verify.contract_empty",
                fix="add at least one check, or run the loop for advisory "
                "visual feedback instead of claiming verification",
            )
        frozen = self.model_copy(
            update={
                "frozen_at": datetime.now(UTC).isoformat(timespec="seconds"),
                "created_by": created_by or self.created_by,
            }
        )
        return frozen.model_copy(update={"digest": frozen.compute_digest()})

    def revise(self, checks: list[Check], *, created_by: str = "unknown") -> VerificationContract:
        """A changed contract is a new contract revision, never an edit.

        The previous digest is recorded in the id so an evidence bundle can be
        traced back through the chain.
        """
        return VerificationContract(
            contract_id=f"{self.contract_id}+r{len(checks)}",
            title=self.title,
            created_by=created_by,
            checks=checks,
            required_assurance=self.required_assurance,
            source_prompt=self.source_prompt,
        )

    def verify_integrity(self) -> None:
        """Raise unless this contract still matches the digest it was frozen with."""
        if not self.frozen:
            raise ContractError(
                f"contract {self.contract_id} was never frozen",
                code="verify.contract_not_frozen",
                fix="freeze() the contract BEFORE the run it judges — a "
                "contract fixed afterwards proves nothing",
                details={"contract_id": self.contract_id},
            )
        if self.compute_digest() != self.digest:
            raise ContractError(
                f"contract {self.contract_id} was modified after freezing",
                code="verify.contract_tampered",
                fix="re-run against the original contract, or freeze a new "
                "revision and re-run the agent against that",
                details={"contract_id": self.contract_id,
                         "recorded_digest": self.digest,
                         "actual_digest": self.compute_digest()},
            )

    @property
    def required_checks(self) -> list[Check]:
        return [check for check in self.checks if check.required]


def merge_draft(
    frozen: VerificationContract, proposed: list[Check]
) -> list[Check]:
    """Fold model-proposed checks into a frozen contract's check list.

    Additions are allowed and land as **advisory** regardless of what the
    proposal said. A required check that already exists cannot be removed,
    relaxed, or downgraded — that rule is what stops a model from negotiating
    its way to a pass.
    """
    existing = {check.id: check for check in frozen.checks}
    merged = list(frozen.checks)
    for check in proposed:
        if check.id in existing:
            continue  # never overwrite; a frozen check is not a suggestion
        merged.append(check.model_copy(update={"required": False}))
    return merged

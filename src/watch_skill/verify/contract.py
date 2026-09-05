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
    """How much a verdict is worth. Ordered weakest to strongest.

    The ladder measures one thing: **how independent the judge was from the
    thing being judged**. Each rung states what it proves and, more usefully,
    what it does not — a level whose limits are unstated will be read as
    stronger than it is, which is the whole failure mode this enum exists to
    prevent.
    """

    VISUAL_ADVISORY = "visual_advisory"
    """A model looked at pictures and formed an opinion.

    Proves: something plausible was said about the evidence.
    Does not prove: anything. Never a passing verdict on its own."""

    DETERMINISTIC_LOCAL = "deterministic_local"
    """Deterministic checks ran in the acting process, as the acting user.

    This is the *same-process* level. Proves: the checks are reproducible and
    did not involve a model. Does not prove: independence — the code under
    test shares an interpreter with its own judge and could have altered it."""

    ISOLATED_LOCAL = "isolated_local"
    """Deterministic checks ran in a separate, sanitized child process.

    Proves: the checks could not read the parent's provider keys, could not
    corrupt its interpreter state, and could not outlive their deadline.
    Does not prove: independence from an agent running **as the same user** on
    the same machine. That agent can still write the target, the evidence, and
    the receipt store between runs. This is the strongest level Watch Skill
    can establish without new authority, and it is not "external"."""

    EXTERNAL_READ_ONLY = "external_read_only"
    """Checks ran under a *different* identity with read-only target access.

    Proves: the acting agent could not have written what the verifier read,
    because it lacks permission to. Requires a real boundary — a container
    with a read-only mount, or a separate OS user — and is refused rather
    than approximated when one cannot be established."""

    HUMAN_ATTESTED = "human_attested"
    """A named person inspected the evidence and signed off.

    Proves: a human with context agreed. Does not prove: reproducibility.
    Strong precisely where machines are weak, and weak where they are strong,
    which is why it sits above the machine levels rather than replacing
    them."""

    REMOTE_ATTESTED = "remote_attested"
    """Checks ran on an independent machine and signed the result. Watch Skill
    does not implement this; the level exists so nothing else can claim it."""


_ORDER = [
    Assurance.VISUAL_ADVISORY,
    Assurance.DETERMINISTIC_LOCAL,
    Assurance.ISOLATED_LOCAL,
    Assurance.EXTERNAL_READ_ONLY,
    Assurance.HUMAN_ATTESTED,
    Assurance.REMOTE_ATTESTED,
]

# What each rung is worth, as data rather than prose. A string literal after
# an enum member is not that member's docstring — Python leaves `__doc__`
# pointing at the class — so anything that needs these semantics at runtime
# (the `assurance` CLI, the ladder description, the tests that keep every
# level honest) has to read them from here.
ASSURANCE_SEMANTICS: dict[Assurance, dict[str, str]] = {
    Assurance.VISUAL_ADVISORY: {
        "proves": "something plausible was said about the evidence",
        "does_not_prove": "anything at all; never a passing verdict alone",
    },
    Assurance.DETERMINISTIC_LOCAL: {
        "proves": "the checks are reproducible and involved no model",
        "does_not_prove": "independence — the code under test shares an "
                          "interpreter with its own judge",
    },
    Assurance.ISOLATED_LOCAL: {
        "proves": "the checks could not read the parent's keys, corrupt its "
                  "state, or outlive their deadline",
        "does_not_prove": "independence from an agent running as the same "
                          "user, which can still write the target, the "
                          "evidence and the receipt store between runs",
    },
    Assurance.EXTERNAL_READ_ONLY: {
        "proves": "the acting agent lacked permission to write what the "
                  "verifier read",
        "does_not_prove": "that the target itself is trustworthy, only that "
                          "the actor did not author the reading",
    },
    Assurance.HUMAN_ATTESTED: {
        "proves": "a named person with context inspected the evidence",
        "does_not_prove": "reproducibility; a second person may disagree",
    },
    Assurance.REMOTE_ATTESTED: {
        "proves": "an independent machine ran the checks and signed the result",
        "does_not_prove": "anything here — Watch Skill does not implement it, "
                          "and the level exists so nothing can claim it",
    },
}


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
    # Origins the network checks in this contract may reach, and nothing else.
    #
    # Part of the frozen agreement rather than a runtime flag, because that is
    # the only place it is safe: the digest covers it, so a contract cannot be
    # widened after it was agreed to, and an evidence bundle records exactly
    # which origins the run was permitted.
    #
    # It was missing, and the effect was that `http_request` and `browser_dom`
    # — two of the fourteen check types — could not be used from the command
    # line at all. `_assert_public_origin` refuses an origin that is not
    # allowlisted, the failure text says "add the host to the contract's
    # allowed_origins", and there was no such field to add it to. A loopback
    # dev server, which the guard's own docstring calls a legitimate and
    # common case, was unreachable.
    allowed_origins: list[str] = Field(default_factory=list)
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
            allowed_origins=list(self.allowed_origins),
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

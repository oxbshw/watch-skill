"""One policy that every network and provider boundary asks before acting.

Before this module, "offline" was a *cost* setting consulted by one function
in the answer ladder. A configured cloud key therefore meant indexing-time
scene descriptions uploaded frames whether or not the operator had agreed to
that, and nothing in the system could answer "what will this run send, and
where?" ahead of time.

Two policies live here, deliberately separate, because they answer different
questions:

*execution/egress* — may these bytes leave this machine, and to whom;
*cost* — how much money may this run spend.

An operator can want cheap-and-cloudy or expensive-and-local, and collapsing
the two makes one of those unrepresentable.

Enforcement is central: :func:`guard_egress` is the only gate, every boundary
calls it, and :func:`assert_no_network_boundaries` in the test suite fails the
build if a new boundary forgets to. Individual features must not build a
provider client and go around it.
"""
from __future__ import annotations

import threading
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from pydantic import BaseModel, Field

from watch_skill.errors import PolicyError


class Channel(str, Enum):  # noqa: UP042 — matches SourceKind
    """A kind of thing that can leave the machine.

    Split finely on purpose: "send OCR text to a model" and "upload the frame
    that text came from" are very different disclosures, and an operator who
    permits one has not permitted the other.
    """

    SOURCE = "source_acquisition"
    """Fetching the video itself (yt-dlp, ffmpeg, cobalt)."""

    FRAMES = "frame_egress"
    """Extracted images sent to a model."""

    AUDIO = "audio_egress"
    """Extracted audio sent to a speech-to-text API."""

    TEXT = "text_egress"
    """Transcript, OCR and question text sent to a model."""

    CLOUD_MODEL = "cloud_model"
    """Any call to a hosted inference provider."""

    LOCAL_MODEL = "local_model"
    """Any call to a model on this machine (Ollama, a local server)."""

    WEBHOOK = "webhook"
    """Loop/monitor events POSTed to an operator-configured endpoint."""

    TELEMETRY = "telemetry"
    """Usage reporting. Watch Skill sends none; the channel exists so the
    policy can state that, and so an added integration cannot slip past."""

    VERIFICATION_HTTP = "verification_http"
    """HTTP assertions made by a verification contract."""


class SceneDescriptionMode(str, Enum):  # noqa: UP042 — matches SourceKind
    """Where indexing-time scene descriptions may be computed."""

    OFF = "off"
    LOCAL = "local"
    CLOUD = "cloud"
    AUTO = "auto"
    """Local when a local backend is up, cloud ONLY if frame egress is already
    permitted, otherwise off. Never an implicit upgrade to cloud."""


@dataclass(frozen=True)
class Decision:
    """The answer to one guard question."""

    allowed: bool
    channel: Channel
    reason: str
    provider: str | None = None

    def raise_if_denied(self) -> None:
        if self.allowed:
            return
        raise PolicyError(
            f"{self.channel.value} is not permitted: {self.reason}",
            code=f"policy.{self.channel.value}_denied",
            fix=_FIXES[self.channel],
            details={"channel": self.channel.value, "provider": self.provider,
                     "reason": self.reason},
        )


_FIXES: dict[Channel, str] = {
    Channel.SOURCE: "drop --offline, or point at a file that is already local",
    Channel.FRAMES: "set WATCHSKILL_COST_POLICY to something other than "
                    "offline_only, or run a local vision backend "
                    "(`watch-skill setup-vision`) so frames never leave",
    Channel.AUDIO: "set WATCHSKILL_CLOUD_STT_ENABLED=1 to opt in, or leave it "
                   "off and let local whisper transcribe",
    Channel.TEXT: "set WATCHSKILL_COST_POLICY to something other than "
                  "offline_only to allow cloud model calls",
    Channel.CLOUD_MODEL: "cloud providers are disabled by the current policy; "
                         "configure a local provider or relax the policy",
    Channel.LOCAL_MODEL: "local model calls are disabled by the current policy",
    Channel.WEBHOOK: "webhooks are disabled by the current policy; unset "
                     "--offline or WATCHSKILL_WEBHOOK_URL",
    Channel.TELEMETRY: "Watch Skill sends no telemetry; this channel is "
                       "permanently denied",
    Channel.VERIFICATION_HTTP: "add the host to the contract's allowed_origins",
}


class ExecutionPolicy(BaseModel):
    """The effective rules for one run. Frozen once resolved."""

    model_config = {"frozen": True}

    offline: bool = Field(
        default=False,
        description="Hard mode: no outbound network call of any kind, "
        "including source acquisition.",
    )
    allow_source_network: bool = True
    allow_frame_egress: bool = True
    allow_audio_egress: bool = False
    allow_text_egress: bool = True
    allow_cloud_models: bool = True
    allow_local_models: bool = True
    allow_webhooks: bool = True
    allow_telemetry: bool = False
    provider_allowlist: tuple[str, ...] | None = Field(
        default=None,
        description="When set, only these providers may be called. None = any "
        "configured provider.",
    )
    scene_descriptions: SceneDescriptionMode = SceneDescriptionMode.AUTO
    max_usd_per_call: float = 1.0
    max_usd_per_run: float = 5.0
    request_timeout_seconds: float = 180.0
    max_retries: int = 1

    # --- the single question every boundary asks ---------------------------

    def check(self, channel: Channel, *, provider: str | None = None) -> Decision:
        """Whether this channel may be used, and why not when it may not."""
        local = provider in _LOCAL_PROVIDERS
        if self.offline and not (channel is Channel.LOCAL_MODEL or local):
            return Decision(False, channel, "offline mode is on", provider)

        if provider and self.provider_allowlist is not None \
                and provider not in self.provider_allowlist:
            return Decision(
                False, channel,
                f"provider {provider!r} is not in the allowlist", provider,
            )

        if not local and provider is not None and not self.allow_cloud_models \
                and channel in (Channel.FRAMES, Channel.TEXT, Channel.AUDIO,
                                Channel.CLOUD_MODEL):
            return Decision(False, channel, "cloud model access is disabled", provider)

        flag = {
            Channel.SOURCE: self.allow_source_network,
            Channel.FRAMES: self.allow_frame_egress or local,
            Channel.AUDIO: self.allow_audio_egress or local,
            Channel.TEXT: self.allow_text_egress or local,
            Channel.CLOUD_MODEL: self.allow_cloud_models,
            Channel.LOCAL_MODEL: self.allow_local_models,
            Channel.WEBHOOK: self.allow_webhooks,
            Channel.TELEMETRY: self.allow_telemetry,
            Channel.VERIFICATION_HTTP: not self.offline,
        }[channel]
        if not flag:
            return Decision(False, channel, "disabled by policy", provider)
        return Decision(True, channel, "permitted by policy", provider)

    def describes_scene_egress(self) -> SceneDescriptionMode:
        """Resolve ``auto`` without ever upgrading to cloud on its own.

        A configured API key is not consent to upload every frame of every
        video at indexing time; that is the specific hole this closes.
        """
        if self.scene_descriptions is not SceneDescriptionMode.AUTO:
            return self.scene_descriptions
        if self.offline or not self.allow_frame_egress or not self.allow_cloud_models:
            return SceneDescriptionMode.LOCAL
        return SceneDescriptionMode.CLOUD

    def to_dict(self) -> dict[str, Any]:
        data = self.model_dump()
        data["scene_descriptions"] = self.scene_descriptions.value
        data["scene_descriptions_effective"] = self.describes_scene_egress().value
        data["provider_allowlist"] = (
            list(self.provider_allowlist) if self.provider_allowlist else None
        )
        return data


# Providers whose traffic never leaves the machine. Membership here is what
# makes "offline" compatible with "still able to see", so it is a closed list
# rather than anything derived from a URL an operator could point outward.
_LOCAL_PROVIDERS = frozenset({"ollama"})


def is_local_provider(provider: str | None) -> bool:
    return provider in _LOCAL_PROVIDERS


# --- resolution from settings ----------------------------------------------


def _from_settings() -> ExecutionPolicy:
    from watch_skill.config import get_settings

    settings = get_settings()
    offline = bool(settings.offline)
    # `offline_only` has always meant "cloud never sees a frame". It now means
    # that literally and everywhere, instead of only inside the answer ladder.
    cloud_models = settings.cost_policy != "offline_only" and not offline
    try:
        scene_mode = SceneDescriptionMode(settings.scene_descriptions)
    except ValueError:
        scene_mode = SceneDescriptionMode.AUTO
    allowlist = tuple(
        p.strip() for p in (settings.provider_allowlist or "").split(",") if p.strip()
    ) or None
    return ExecutionPolicy(
        offline=offline,
        allow_source_network=not offline,
        allow_frame_egress=cloud_models,
        allow_audio_egress=bool(settings.cloud_stt_enabled) and cloud_models,
        allow_text_egress=cloud_models,
        allow_cloud_models=cloud_models,
        allow_local_models=True,
        allow_webhooks=not offline,
        allow_telemetry=False,
        provider_allowlist=allowlist,
        scene_descriptions=scene_mode,
        max_usd_per_call=settings.cost_ceiling_usd,
        max_usd_per_run=settings.cost_ceiling_run_usd,
        request_timeout_seconds=settings.vision_timeout_seconds,
    )


_state = threading.local()


def get_policy() -> ExecutionPolicy:
    """The effective policy for the current thread."""
    policy = getattr(_state, "policy", None)
    if policy is None:
        policy = _from_settings()
        _state.policy = policy
    return policy


def reset_policy() -> None:
    """Drop the cached policy (tests, and after a settings change)."""
    _state.policy = None
    _state.ledger = None


class _PolicyScope:
    def __init__(self, policy: ExecutionPolicy) -> None:
        self._policy = policy
        self._previous: ExecutionPolicy | None = None

    def __enter__(self) -> ExecutionPolicy:
        self._previous = getattr(_state, "policy", None)
        _state.policy = self._policy
        return self._policy

    def __exit__(self, *exc: object) -> None:
        _state.policy = self._previous


def use_policy(policy: ExecutionPolicy) -> _PolicyScope:
    """Run a block under an explicit policy (surfaces pass CLI overrides)."""
    return _PolicyScope(policy)


def guard_egress(channel: Channel, *, provider: str | None = None) -> Decision:
    """THE gate. Raises :class:`PolicyError` when the channel is closed."""
    decision = get_policy().check(channel, provider=provider)
    decision.raise_if_denied()
    return decision


# --- run-scoped cost ledger -------------------------------------------------


@dataclass
class CostLedger:
    """What one run has spent, and on what.

    Every priced call lands here — indexing descriptions, answers, loop
    critics, library synthesis, extraction, verification — not just follow-up
    questions, which is all the previous meter counted. Estimates and
    provider-reported usage are kept apart so a report never presents one as
    the other.
    """

    estimated_usd: float = 0.0
    reported_usd: float = 0.0
    calls: int = 0
    by_phase: dict[str, float] = field(default_factory=dict)
    reported_tokens: dict[str, int] = field(default_factory=dict)

    def record(
        self,
        phase: str,
        *,
        estimated_usd: float = 0.0,
        reported_usd: float | None = None,
        usage: dict[str, Any] | None = None,
    ) -> None:
        self.calls += 1
        self.estimated_usd += estimated_usd
        self.by_phase[phase] = self.by_phase.get(phase, 0.0) + estimated_usd
        if reported_usd is not None:
            self.reported_usd += reported_usd
        for key, value in (usage or {}).items():
            if isinstance(value, int):
                self.reported_tokens[key] = self.reported_tokens.get(key, 0) + value

    def to_dict(self) -> dict[str, Any]:
        return {
            "calls": self.calls,
            "estimated_usd": round(self.estimated_usd, 6),
            "estimated": True,
            "provider_reported_usd": round(self.reported_usd, 6) or None,
            "by_phase_estimated_usd": {k: round(v, 6) for k, v in self.by_phase.items()},
            "provider_reported_tokens": self.reported_tokens or None,
        }


def get_ledger() -> CostLedger:
    ledger = getattr(_state, "ledger", None)
    if ledger is None:
        ledger = CostLedger()
        _state.ledger = ledger
    return ledger


def charge(
    phase: str,
    *,
    estimated_usd: float = 0.0,
    reported_usd: float | None = None,
    usage: dict[str, Any] | None = None,
) -> None:
    """Record spend and stop the run at the ceiling.

    The per-run ceiling is checked *after* recording so the ledger reflects
    what was actually spent, and the next call is the one refused.
    """
    ledger = get_ledger()
    ledger.record(phase, estimated_usd=estimated_usd, reported_usd=reported_usd,
                  usage=usage)
    ceiling = get_policy().max_usd_per_run
    if ceiling > 0 and ledger.estimated_usd > ceiling:
        raise PolicyError(
            f"run cost ${ledger.estimated_usd:.2f} passed the ceiling ${ceiling:.2f}",
            code="policy.run_cost_ceiling",
            fix="raise WATCHSKILL_COST_CEILING_RUN_USD, use a cheaper tier, or "
            "run offline (WATCHSKILL_COST_POLICY=offline_only)",
            details=ledger.to_dict(),
        )


# --- the plan a run can state before it runs --------------------------------


def execution_plan(
    *,
    phase: str,
    provider: str | None = None,
    model: str | None = None,
    frames: int = 0,
    audio_payloads: int = 0,
    estimated_usd: float = 0.0,
) -> dict[str, Any]:
    """What a run intends to do, before it does it.

    Reported by ``watch-skill plan`` and the ``execution_plan`` tool so an
    operator can see the provider, the payload counts, the network actions and
    the cost ceiling *before* anything is sent.
    """
    policy = get_policy()
    local = is_local_provider(provider)
    network: list[str] = []
    blocked: list[str] = []

    # The plan has to describe what will ACTUALLY happen, so each payload is
    # run past the same guard the real call will hit. Listing an upload the
    # policy is about to refuse would make the plan worse than useless: it
    # would tell an operator their frames are leaving when they are not.
    def consider(channel: Channel, count: int, description: str) -> None:
        if not count:
            return
        decision = policy.check(channel, provider=provider)
        if not decision.allowed:
            blocked.append(f"{description} — refused: {decision.reason}")
        elif local:
            network.append(f"POST to the local {provider} server (loopback only)")
        else:
            network.append(description)

    consider(Channel.FRAMES, frames, f"POST {frames} frame image(s) to {provider}")
    consider(Channel.AUDIO, audio_payloads,
             f"POST {audio_payloads} audio payload(s) to {provider}")

    return {
        "phase": phase,
        "provider": provider,
        "model": model,
        "local_only": local or policy.offline or not network,
        "frames": frames,
        "audio_payloads": audio_payloads,
        "network_actions": sorted(set(network)) or ["none"],
        "blocked_by_policy": blocked,
        "estimated_max_usd": round(estimated_usd if network else 0.0, 6),
        "estimated": True,
        "cost_ceiling_usd": policy.max_usd_per_call,
        "run_ceiling_usd": policy.max_usd_per_run,
        "policy": policy.to_dict(),
    }

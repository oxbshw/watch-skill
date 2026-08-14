"""The execution/egress policy, and the proof that offline means offline.

The headline test runs the engine with EVERY supported cloud key populated and
asserts that not one outbound HTTP call is attempted. Before the policy
existed a configured key was read as consent, so indexing a video uploaded its
frames whether or not the operator had agreed to that.
"""
from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import httpx
import pytest

from watch_skill.config import reset_settings
from watch_skill.errors import PolicyError
from watch_skill.policy import (
    Channel,
    ExecutionPolicy,
    SceneDescriptionMode,
    execution_plan,
    get_ledger,
    get_policy,
    guard_egress,
    reset_policy,
    use_policy,
)

_ALL_KEYS = (
    "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY",
    "GROQ_API_KEY", "MINIMAX_API_KEY", "TOGETHER_API_KEY", "FIREWORKS_API_KEY",
    "DEEPSEEK_API_KEY", "XAI_API_KEY", "MISTRAL_API_KEY", "MOONSHOT_API_KEY",
    "ZAI_API_KEY", "QWEN_API_KEY", "CUSTOM_API_KEY", "HUGGINGFACE_TOKEN",
)


@pytest.fixture
def every_key_set(monkeypatch: pytest.MonkeyPatch) -> None:
    """Populate every provider key Watch Skill knows about."""
    for name in _ALL_KEYS:
        monkeypatch.setenv(f"WATCHSKILL_{name}", f"sk-test-{name.lower()}")
    reset_settings()
    yield
    reset_settings()


@pytest.fixture
def no_network(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """Fail loudly on any outbound HTTP attempt, and record it."""
    attempts: list[str] = []

    def deny(*args: object, **kwargs: object):
        url = kwargs.get("url") or (args[1] if len(args) > 1 else args[0] if args else "?")
        attempts.append(str(url))
        raise AssertionError(f"outbound network call attempted: {url}")

    for name in ("post", "get", "put", "stream", "request"):
        monkeypatch.setattr(httpx, name, deny, raising=False)
    monkeypatch.setattr(httpx.Client, "request", deny, raising=False)

    import urllib.request

    monkeypatch.setattr(urllib.request, "urlopen", deny)
    return attempts


def _clip(path: Path, colour: str = "red") -> Path:
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg is None:
        pytest.skip("ffmpeg not available")
    path.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [ffmpeg, "-y", "-f", "lavfi", "-i", f"color=c={colour}:s=320x240:d=2:r=10",
         "-c:v", "libx264", "-pix_fmt", "yuv420p", str(path)],
        check=True, capture_output=True,
    )
    return path


# --- the headline guarantee -------------------------------------------------


def test_offline_watch_makes_zero_outbound_calls_with_every_key_set(
    tmp_path: Path, every_key_set: None, no_network: list[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from watch_skill.index.store import index_watch_result
    from watch_skill.watch import watch

    monkeypatch.setenv("WATCHSKILL_OFFLINE", "1")
    reset_settings()
    assert get_policy().offline

    clip = _clip(tmp_path / "local.mp4")
    video_id = index_watch_result(watch(str(clip), transcript_only=True))
    assert video_id
    assert attempts_are_empty(no_network)


def test_offline_only_cost_policy_blocks_frame_egress_at_index_time(
    tmp_path: Path, every_key_set: None, no_network: list[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A configured key is not consent to upload every indexed frame."""
    from watch_skill.index.store import index_watch_result
    from watch_skill.watch import watch

    monkeypatch.setenv("WATCHSKILL_COST_POLICY", "offline_only")
    reset_settings()

    clip = _clip(tmp_path / "local.mp4")
    index_watch_result(watch(str(clip), transcript_only=True), describe_scenes=True)
    assert attempts_are_empty(no_network)


def attempts_are_empty(attempts: list[str]) -> bool:
    assert attempts == [], f"policy leaked these calls: {attempts}"
    return True


def test_offline_rejects_a_remote_url_with_a_structured_error(
    monkeypatch: pytest.MonkeyPatch, no_network: list[str]
) -> None:
    from watch_skill.acquire import acquire
    from watch_skill.errors import AcquisitionError

    monkeypatch.setenv("WATCHSKILL_OFFLINE", "1")
    reset_settings()
    with pytest.raises(AcquisitionError) as raised:
        acquire("https://example.com/watch?v=abc")
    assert raised.value.code == "acquire.offline_denied"
    assert raised.value.fix
    assert attempts_are_empty(no_network)


def test_offline_blocks_a_cloud_vision_call_before_the_key_is_read(
    every_key_set: None, monkeypatch: pytest.MonkeyPatch, no_network: list[str]
) -> None:
    from watch_skill.vision.client import VisionClient

    monkeypatch.setenv("WATCHSKILL_OFFLINE", "1")
    reset_settings()
    with pytest.raises(PolicyError) as raised:
        VisionClient(provider="anthropic", model="claude-sonnet-5").generate("hi")
    assert raised.value.code.startswith("policy.")
    assert attempts_are_empty(no_network)


def test_offline_blocks_cloud_stt_even_when_opted_in(
    tmp_path: Path, every_key_set: None, monkeypatch: pytest.MonkeyPatch,
    no_network: list[str],
) -> None:
    """Standing consent does not override the policy for this run."""
    from watch_skill.transcribe.cloud import transcribe_cloud

    monkeypatch.setenv("WATCHSKILL_CLOUD_STT_ENABLED", "1")
    monkeypatch.setenv("WATCHSKILL_OFFLINE", "1")
    reset_settings()
    with pytest.raises(PolicyError):
        transcribe_cloud(tmp_path / "x.mp4", tmp_path)
    assert attempts_are_empty(no_network)


def test_offline_blocks_webhooks(
    monkeypatch: pytest.MonkeyPatch, no_network: list[str]
) -> None:
    from watch_skill.loop.webhook import deliver_event

    monkeypatch.setenv("WATCHSKILL_OFFLINE", "1")
    reset_settings()
    with pytest.raises(PolicyError):
        deliver_event({"a": 1}, "https://hooks.example.com/x")
    assert attempts_are_empty(no_network)


# --- policy semantics -------------------------------------------------------


def test_local_providers_still_work_offline() -> None:
    with use_policy(ExecutionPolicy(offline=True)):
        assert guard_egress(Channel.LOCAL_MODEL, provider="ollama").allowed
        assert guard_egress(Channel.FRAMES, provider="ollama").allowed


def test_allowlist_refuses_a_provider_not_on_it() -> None:
    policy = ExecutionPolicy(provider_allowlist=("ollama",))
    with use_policy(policy):
        with pytest.raises(PolicyError) as raised:
            guard_egress(Channel.CLOUD_MODEL, provider="openai")
        assert "allowlist" in raised.value.message


def test_auto_scene_descriptions_never_upgrade_to_cloud_on_their_own() -> None:
    offline = ExecutionPolicy(offline=True, scene_descriptions=SceneDescriptionMode.AUTO)
    assert offline.describes_scene_egress() is SceneDescriptionMode.LOCAL
    no_egress = ExecutionPolicy(
        allow_frame_egress=False, scene_descriptions=SceneDescriptionMode.AUTO
    )
    assert no_egress.describes_scene_egress() is SceneDescriptionMode.LOCAL


def test_telemetry_is_permanently_closed() -> None:
    with use_policy(ExecutionPolicy()), pytest.raises(PolicyError):
        guard_egress(Channel.TELEMETRY)


def test_audio_egress_is_off_by_default() -> None:
    with use_policy(ExecutionPolicy()), pytest.raises(PolicyError):
        guard_egress(Channel.AUDIO, provider="groq")


# --- cost ledger ------------------------------------------------------------


def test_run_ledger_stops_the_run_at_the_ceiling() -> None:
    from watch_skill.policy import charge

    reset_policy()
    with use_policy(ExecutionPolicy(max_usd_per_run=0.10)):
        charge("index.describe_scenes", estimated_usd=0.06)
        with pytest.raises(PolicyError) as raised:
            charge("answer", estimated_usd=0.06)
        assert raised.value.code == "policy.run_cost_ceiling"
    reset_policy()


def test_ledger_separates_estimated_from_provider_reported() -> None:
    from watch_skill.policy import charge

    reset_policy()
    with use_policy(ExecutionPolicy(max_usd_per_run=100.0)):
        charge("answer", estimated_usd=0.02, reported_usd=0.017,
               usage={"input_tokens": 900})
        data = get_ledger().to_dict()
    assert data["estimated"] is True
    assert data["estimated_usd"] == pytest.approx(0.02)
    assert data["provider_reported_usd"] == pytest.approx(0.017)
    assert data["provider_reported_tokens"] == {"input_tokens": 900}
    reset_policy()


def test_ledger_attributes_spend_to_the_phase_that_spent_it() -> None:
    from watch_skill.policy import charge

    reset_policy()
    with use_policy(ExecutionPolicy(max_usd_per_run=100.0)):
        charge("index.describe_scenes", estimated_usd=0.01)
        charge("loop.critic", estimated_usd=0.02)
        charge("verify", estimated_usd=0.03)
        phases = get_ledger().to_dict()["by_phase_estimated_usd"]
    assert set(phases) == {"index.describe_scenes", "loop.critic", "verify"}
    reset_policy()


# --- the plan a run states before it runs -----------------------------------


def test_execution_plan_states_the_network_actions_ahead_of_time() -> None:
    with use_policy(ExecutionPolicy()):
        plan = execution_plan(
            phase="loop.critic", provider="anthropic", model="claude-sonnet-5",
            frames=10, estimated_usd=0.04,
        )
    assert plan["frames"] == 10
    assert any("10 frame" in action for action in plan["network_actions"])
    assert plan["estimated"] is True
    assert plan["local_only"] is False


def test_execution_plan_reports_no_network_when_offline() -> None:
    with use_policy(ExecutionPolicy(offline=True)):
        plan = execution_plan(phase="watch", provider=None, model=None)
    assert plan["network_actions"] == ["none"]
    assert plan["local_only"] is True
    assert plan["policy"]["offline"] is True


def test_execution_plan_never_promises_an_upload_the_policy_will_refuse() -> None:
    """The plan describes what happens, not what would happen unguarded."""
    with use_policy(ExecutionPolicy(offline=True)):
        plan = execution_plan(
            phase="index.describe_scenes", provider="anthropic",
            model="claude-haiku-4-5-20251001", frames=24, estimated_usd=0.12,
        )
    assert plan["network_actions"] == ["none"]
    assert plan["local_only"] is True
    assert plan["estimated_max_usd"] == 0.0
    assert any("24 frame" in line and "refused" in line
               for line in plan["blocked_by_policy"])


def test_execution_plan_reports_a_real_upload_when_one_is_permitted() -> None:
    with use_policy(ExecutionPolicy()):
        plan = execution_plan(phase="answer", provider="anthropic",
                              model="claude-sonnet-5", frames=6,
                              estimated_usd=0.03)
    assert plan["network_actions"] == ["POST 6 frame image(s) to anthropic"]
    assert plan["blocked_by_policy"] == []
    assert plan["estimated_max_usd"] == pytest.approx(0.03)


def test_execution_plan_marks_a_local_provider_as_loopback() -> None:
    with use_policy(ExecutionPolicy()):
        plan = execution_plan(phase="answer", provider="ollama",
                              model="moondream", frames=6)
    assert plan["local_only"] is True
    assert all("loopback" in action for action in plan["network_actions"])


def test_secrets_never_appear_in_the_policy_snapshot(every_key_set: None) -> None:
    snapshot = repr(get_policy().to_dict())
    assert "sk-test" not in snapshot

"""The Adversal adapter classifies real replies and leaks no secrets.

Every message string asserted on here is copied from Adversal MCP 0.1.4's
own source or captured verbatim from a live run against it, so these test a
parser against the thing it parses rather than against a convenient
invention.

The adapter is the only place that turns English into a status, and two
mistakes there would be expensive: reading a refusal as a result, and
writing a token into a file meant to be sent to the vendor. Both are held
below.
"""
from __future__ import annotations

import json

import pytest

from watch_skill.bench.video_backends.adapters import adversal_parse as parse
from watch_skill.bench.video_backends.adapters.adversal_mcp import (
    read_frames_json,
    read_requested_frames,
    read_transcript_json,
)
from watch_skill.bench.video_backends.sanitize import (
    build_placeholders,
    environment_summary,
    sanitize,
    sanitize_text,
)
from watch_skill.bench.video_backends.types import OutcomeStatus

# Verbatim from adversal-cli 0.1.4 (mcp_client.py) or captured from a live run.
AUTH_REQUIRED = (
    "AUTHENTICATION REQUIRED.\n\nNo saved Adversal session was found.\n\n"
    "ACTION REQUIRED: call the `authenticate` MCP tool. It will open the "
    "Adversal sign-in page in the user's browser."
)
COMPLETED = (
    "COMPLETED — the video-processing pipeline finished successfully.\n\n"
    "  request_id: 7f3a9c21-0b44-4d2e-9a10-55c6d1e8b0aa\n"
    "  video_path: /tmp/clip.mp4\n\n"
    "Call `analyze`, `transcribe`, or `extract_frames` with this request_id"
)
SUCCESS = (
    "SUCCESS — frames downloaded.\n\n"
    "  request_id: 7f3a9c21-0b44-4d2e-9a10-55c6d1e8b0aa\n"
    "  output_path: /tmp/out/frames"
)
NOT_READY = (
    "NOT READY — the job status is RUNNING.\n\n"
    "  request_id: 7f3a9c21-0b44-4d2e-9a10-55c6d1e8b0aa\n\n"
    "Call `check_video_status` first."
)
NOT_SUBMITTED = (
    'NOT SUBMITTED — no local job was found for request_id "abc". '
    "Call `process_video` first."
)
UNAVAILABLE = (
    'UNAVAILABLE — the backend has no accessible transcript artifact for '
    'request_id "abc". This hash was released for re-submission'
)
FAILED = (
    "FAILED — the pipeline did not complete successfully.\n\n"
    "  request_id: abc\n  error: decoder gave up"
)
QUOTA = (
    "QUOTA EXHAUSTED — your Adversal video-processing minutes are used up.\n\n"
    "Visit https://adversal.ai to manage your subscription."
)
EXISTING = (
    "This video already has a non-failed processing job.\n\n"
    "  request_id: 7f3a9c21-0b44-4d2e-9a10-55c6d1e8b0aa\n"
    "  status: COMPLETED\n"
    "  hash: 78fd2c2158b38064fac0710d876f35ae\n\n"
    "The pipeline has already completed."
)
# Captured live: a text file renamed .mp4. No status marker at all.
UNSTRUCTURED = (
    "Could not determine the video duration: [mov,mp4,m4a,3gp,3g2,mj2 @ 000001fb] "
    "moov atom not found\r\nC:\\tmp\\not-a-video.mp4: Invalid data found"
)


@pytest.mark.parametrize(
    ("message", "expected"),
    [
        (AUTH_REQUIRED, OutcomeStatus.AUTH_REQUIRED),
        (COMPLETED, OutcomeStatus.OK),
        (SUCCESS, OutcomeStatus.OK),
        (EXISTING, OutcomeStatus.OK),
        (NOT_READY, OutcomeStatus.NOT_READY),
        (NOT_SUBMITTED, OutcomeStatus.NOT_SUBMITTED),
        (UNAVAILABLE, OutcomeStatus.UNAVAILABLE),
        (FAILED, OutcomeStatus.FAILED),
        (QUOTA, OutcomeStatus.QUOTA_EXHAUSTED),
        ("Provide exactly one source: video_path or video_url.",
         OutcomeStatus.INVALID_INPUT),
        ("output_path is required.", OutcomeStatus.INVALID_INPUT),
        ("Video file not found: /tmp/x.mp4", OutcomeStatus.INVALID_INPUT),
        ("Video file is not readable or is empty: /tmp/x.mp4",
         OutcomeStatus.INVALID_INPUT),
        ("video_url must point to a public host, not localhost.",
         OutcomeStatus.INVALID_INPUT),
        ("Invalid timestamps: duplicate timestamp values are not allowed.",
         OutcomeStatus.INVALID_INPUT),
        ("Invalid focused time window: end_time must be later than start_time.",
         OutcomeStatus.INVALID_INPUT),
        ("Invalid requested timestamp: 9999 must be earlier than the video duration",
         OutcomeStatus.INVALID_INPUT),
        ("MCP preflight failed: required command not found on PATH: ffmpeg.",
         OutcomeStatus.INVALID_INPUT),
        ('UNKNOWN — no job found for request_id "abc".', OutcomeStatus.NOT_SUBMITTED),
        ("Backend error 500 (https://api/x): boom", OutcomeStatus.TRANSPORT_ERROR),
        ("HTTP connection error while downloading frames: reset",
         OutcomeStatus.TRANSPORT_ERROR),
        ("AUTHENTICATION SERVICE UNAVAILABLE.\n\nDNS failure",
         OutcomeStatus.TRANSPORT_ERROR),
        ("VIDEO TOO LARGE — the file is 3.10 GB", OutcomeStatus.INVALID_INPUT),
    ],
)
def test_every_documented_reply_gets_a_typed_status(
    message: str, expected: OutcomeStatus
) -> None:
    assert parse.classify(message) is expected


# Captured from the first authenticated run. Each of these classified as
# UNKNOWN until it was seen for real, which is the argument for running a
# benchmark against a live service rather than against its documentation.
AUTHENTICATED = (
    "AUTHENTICATED as Some User.\n\nThe running MCP process has been updated. "
    "Retry the original Adversal tool now; no restart is needed."
)
QUOTA_STATUS = (
    "QUOTA STATUS\n\n  remaining_minutes: 600\n  monthly_limit: 600\n"
    "  used_minutes: 0\n  tier: Researcher"
)
EVALUATION_IN_PROCESS = (
    'Backend error 409 (signed-gcs-url): {"detail":"evaluation_in_process"}'
)
SUBMITTED = (
    "SUCCESS — video processing job submitted and now running on the backend.\n\n"
    "  request_id: 01a03f39-fd42-74cb-a6db-4202cd9256e1\n"
    "  hash: 1302d3dd53c264598bd92548625ae952\n  type: generic"
)


def test_a_successful_sign_in_is_not_reported_as_unclassifiable() -> None:
    assert parse.classify(AUTHENTICATED) is OutcomeStatus.OK
    assert parse.classify("AUTHENTICATION FAILED.\n\nboom") is OutcomeStatus.AUTH_REQUIRED


def test_a_busy_backend_is_retryable_not_a_transport_failure() -> None:
    """409 `evaluation_in_process` is a concurrency limit, not a broken pipe.

    The backend runs one evaluation per account at a time. Calling that a
    transport error would tell a caller to give up on something that only
    needed twenty seconds of patience.
    """
    assert parse.classify(EVALUATION_IN_PROCESS) is OutcomeStatus.NOT_READY
    assert parse.is_retryable(parse.classify(EVALUATION_IN_PROCESS))
    # A different backend error stays non-retryable.
    assert parse.classify("Backend error 500 (x): boom") is OutcomeStatus.TRANSPORT_ERROR


def test_a_submission_yields_both_handles_a_caller_needs() -> None:
    assert parse.request_id(SUBMITTED) == "01a03f39-fd42-74cb-a6db-4202cd9256e1"
    assert parse.content_hash(SUBMITTED) == "1302d3dd53c264598bd92548625ae952"
    assert parse.classify(SUBMITTED) is OutcomeStatus.OK


def test_a_reply_with_no_marker_is_unknown_rather_than_guessed() -> None:
    """0.1.4 really does answer this way; inventing a status would hide it."""
    assert parse.classify(UNSTRUCTURED) is OutcomeStatus.UNKNOWN
    assert parse.classify("") is OutcomeStatus.UNKNOWN
    assert parse.classify("   ") is OutcomeStatus.UNKNOWN


def test_no_refusal_is_ever_classified_as_success() -> None:
    """The mistake that would make a broken backend look like a working one."""
    for message in (AUTH_REQUIRED, NOT_READY, NOT_SUBMITTED, UNAVAILABLE,
                    FAILED, QUOTA, UNSTRUCTURED,
                    "Provide exactly one source: video_path or video_url."):
        assert parse.classify(message) is not OutcomeStatus.OK, message


def test_retryable_is_only_claimed_for_states_that_could_change() -> None:
    assert parse.is_retryable(OutcomeStatus.NOT_READY)
    assert parse.is_retryable(OutcomeStatus.TRANSPORT_ERROR)
    for status in (OutcomeStatus.AUTH_REQUIRED, OutcomeStatus.INVALID_INPUT,
                   OutcomeStatus.FAILED, OutcomeStatus.UNAVAILABLE,
                   OutcomeStatus.QUOTA_EXHAUSTED):
        assert not parse.is_retryable(status), status


def test_the_correlation_handles_are_recovered_from_prose() -> None:
    assert parse.request_id(COMPLETED) == "7f3a9c21-0b44-4d2e-9a10-55c6d1e8b0aa"
    assert parse.output_path(SUCCESS) == "/tmp/out/frames"
    assert parse.reported_status(EXISTING) == "COMPLETED"
    assert parse.content_hash(EXISTING) == "78fd2c2158b38064fac0710d876f35ae"
    assert parse.request_id("nothing here") is None
    assert parse.remaining_minutes("You have 42.5 minutes remaining") == 42.5
    assert parse.remaining_minutes("no number") is None


# --- artifact readers -------------------------------------------------------


def test_requested_frames_carry_the_time_asked_for_not_a_decoded_time(tmp_path):
    """`frame-003-15010ms.jpg` says 15.010 s was *requested*, nothing more."""
    directory = tmp_path / "requested_frames"
    directory.mkdir()
    for name in ("frame-001-20ms.jpg", "frame-002-1700ms.jpg", "frame-003-15010ms.jpg"):
        (directory / name).write_bytes(b"\xff\xd8jpeg")
    (directory / "notes.txt").write_text("ignore me", encoding="utf-8")

    frames = read_requested_frames(directory)
    assert [f.index for f in frames] == [0, 1, 2]
    assert [f.requested_seconds for f in frames] == [0.02, 1.7, 15.01]
    assert all(f.semantics.value == "requested" for f in frames)
    assert all(f.timestamp_seconds == f.requested_seconds for f in frames)


def test_a_missing_frame_directory_yields_nothing_rather_than_raising(tmp_path):
    assert read_requested_frames(tmp_path / "nope") == []


def test_frames_json_keeps_fields_it_did_not_understand(tmp_path):
    """The schema is unverified against the live service — drop nothing."""
    (tmp_path / "frames.json").write_text(json.dumps({
        "frames": [
            {"timestamp": 1.5, "path": "frames/a.jpg", "ocr_text": "EVENT_A",
             "vendor_only": {"score": 7}},
            {"time": "2.5", "filename": "b.jpg"},
        ]
    }), encoding="utf-8")
    frames = read_frames_json(tmp_path)
    assert [f.timestamp_seconds for f in frames] == [1.5, 2.5]
    assert frames[0].ocr_text == "EVENT_A"
    assert frames[0].raw["vendor_only"] == {"score": 7}
    assert all(f.semantics.value == "unknown" for f in frames), (
        "nothing in the payload says what the timestamp means, so we must not claim"
    )


def test_unreadable_artifacts_return_empty_rather_than_half_data(tmp_path):
    (tmp_path / "frames.json").write_text("{not json", encoding="utf-8")
    assert read_frames_json(tmp_path) == []
    (tmp_path / "transcript.json").write_text("{not json", encoding="utf-8")
    assert read_transcript_json(tmp_path) == ([], None)
    assert read_frames_json(tmp_path / "missing") == []


def test_transcript_source_is_reported_only_when_the_payload_states_it(tmp_path):
    """'Probably Whisper' is not provenance."""
    (tmp_path / "transcript.json").write_text(json.dumps({
        "segments": [{"start": 0.0, "end": 1.0, "text": "hello"}]
    }), encoding="utf-8")
    cues, source = read_transcript_json(tmp_path)
    assert len(cues) == 1 and source is None

    (tmp_path / "transcript.json").write_text(json.dumps({
        "source": "captions",
        "segments": [{"start": 0.0, "end": 1.0, "text": "hello"}],
    }), encoding="utf-8")
    _, source = read_transcript_json(tmp_path)
    assert source == "captions"


def test_a_cue_missing_an_end_is_kept_with_end_none(tmp_path):
    (tmp_path / "transcript.json").write_text(json.dumps([
        {"start": 1.0, "text": "no end here"},
    ]), encoding="utf-8")
    cues, _ = read_transcript_json(tmp_path)
    assert cues[0].start == 1.0
    assert cues[0].end is None, "an absent end must not be invented from the start"


# --- sanitization -----------------------------------------------------------


@pytest.mark.parametrize("secret", [
    "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghij",
    "api_key=sk-live-0123456789abcdef",
    "refresh_token: 0123456789abcdefghij",
    "https://user:hunter2@api.example.com/v1",
    "contact someone@example.com for access",
    'password="correct horse battery staple"',
    # The sign-in flow prints a confirmation URL carrying a single-use code.
    # The first version of the redactor did not cover it, and a real run put
    # one in front of us before any test did.
    "https://mcp.adversal.ai/cli-auth-confirm?login_code=exampleonetimecode00",
])
def test_credentials_never_survive_sanitization(secret: str) -> None:
    cleaned = sanitize_text(secret)
    for fragment in ("eyJhbGciOiJIUzI1NiJ9", "sk-live-0123456789abcdef",
                     "0123456789abcdefghij", "hunter2",
                     "someone@example.com", "correct horse",
                     "exampleonetimecode00"):
        assert fragment not in cleaned, f"{fragment!r} leaked from {secret!r}"


def test_the_home_directory_becomes_a_placeholder_not_a_hole() -> None:
    """A redacted record is still a record: shape survives, identity does not."""
    from pathlib import Path

    home = str(Path.home())
    cleaned = sanitize_text(f"{home}/.adversal/jobs.json")
    assert home not in cleaned
    assert "<home>" in cleaned
    assert ".adversal/jobs.json" in cleaned


def test_sanitization_walks_keys_and_nested_structures() -> None:
    from pathlib import Path

    home = str(Path.home())
    payload = {
        f"{home}/key": [{"token": "abcdef123456789"}, Path(f"{home}/x")],
        "nested": {"list": [f"{home}/deep"]},
    }
    cleaned = sanitize(payload)
    assert home not in json.dumps(cleaned)


def test_sanitization_is_idempotent() -> None:
    once = sanitize_text("api_key=sk-live-0123456789abcdef")
    assert sanitize_text(once) == once


def test_request_ids_are_kept_because_the_vendor_needs_them() -> None:
    """Stripping the correlation handle would make the report unactionable."""
    cleaned = sanitize_text(COMPLETED)
    assert "7f3a9c21-0b44-4d2e-9a10-55c6d1e8b0aa" in cleaned


def test_the_environment_summary_is_a_class_of_machine_not_a_fingerprint() -> None:
    summary = environment_summary()
    assert set(summary) == {"os", "machine", "python"}
    # "Windows 10", never "Windows-10-10.0.19045-SP0".
    assert summary["os"].count(".") == 0
    assert build_placeholders(), "there is always at least the home directory to mask"

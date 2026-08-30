"""Which whisper model a run uses, and who gets to decide.

``pick_model_size()`` probes the machine, which is the right default for a
person and the wrong one for anything reproducible: a laptop with a CUDA GPU
loads ``large-v3`` and one without loads ``tiny``, so the same command does
very different work depending on the hardware under it. That is how the
offline suite came to spend longer loading weights than its own 300-second
timeout allowed on one machine while passing on CI, which has no GPU.

``WATCHSKILL_WHISPER_MODEL`` is the override. It was named in the
out-of-memory advice long before anything read it — "try a smaller model
(WATCHSKILL_WHISPER_MODEL=tiny)" — which made that the one piece of guidance
the failure path could give and the one thing it could not do.
"""
from __future__ import annotations

import pytest

from watch_skill.transcribe import local


def test_the_override_wins_over_the_probe(monkeypatch: pytest.MonkeyPatch) -> None:
    # Claim a GPU, so the probe would otherwise insist on the largest model.
    monkeypatch.setattr(local, "has_cuda_gpu", lambda: True)
    monkeypatch.setenv("WATCHSKILL_WHISPER_MODEL", "tiny")

    assert local.pick_model_size() == "tiny"


def test_an_empty_override_is_not_an_override(monkeypatch: pytest.MonkeyPatch) -> None:
    # An unset variable and one set to nothing are the same intention, and
    # neither should produce a model named "".
    monkeypatch.setattr(local, "has_cuda_gpu", lambda: True)
    monkeypatch.setenv("WATCHSKILL_WHISPER_MODEL", "   ")

    assert local.pick_model_size() == local._GPU_MODEL


def test_without_an_override_the_machine_decides(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("WATCHSKILL_WHISPER_MODEL", raising=False)
    monkeypatch.setattr(local, "has_cuda_gpu", lambda: False)
    monkeypatch.setattr(local, "_available_ram_gib", lambda: 32.0)

    assert local.pick_model_size() == "medium"


def test_the_advice_names_a_variable_that_actually_works(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The failure message and the code must name the same variable.

    Read the name out of the advice string rather than restating it, so a
    rename in one place and not the other fails here instead of turning the
    only guidance an out-of-memory user gets into a dead end.
    """
    import inspect
    import re

    advice = inspect.getsource(local.transcribe_local)
    named = re.search(r"\(([A-Z_]+)=(\w+)\)", advice)
    assert named is not None, "the local-whisper failure no longer suggests a variable"
    variable, value = named.group(1), named.group(2)

    monkeypatch.setattr(local, "has_cuda_gpu", lambda: True)
    monkeypatch.setenv(variable, value)

    assert local.pick_model_size() == value, f"{variable} is advertised and not read"

"""The assurance ladder, and refusing to stand higher on it than we do.

The failure this guards against is not a crash. It is a verdict labelled
`external_read_only` on a machine where nothing external ever ran — which
every downstream reader would take to mean the acting side was locked out.
"""
from __future__ import annotations

import pytest

from watch_skill.verify import verify_run
from watch_skill.verify.contract import (
    ASSURANCE_SEMANTICS,
    Assurance,
    Check,
    ContractError,
    VerificationContract,
    assurance_at_least,
)
from watch_skill.verify.isolation import best_available, describe, external_isolation


def test_the_ladder_is_ordered_by_independence_from_the_actor() -> None:
    assert assurance_at_least(Assurance.ISOLATED_LOCAL,
                              Assurance.DETERMINISTIC_LOCAL)
    assert assurance_at_least(Assurance.EXTERNAL_READ_ONLY,
                              Assurance.ISOLATED_LOCAL)
    assert assurance_at_least(Assurance.HUMAN_ATTESTED,
                              Assurance.EXTERNAL_READ_ONLY)
    # And the important negative: a sanitized child process is NOT external.
    assert not assurance_at_least(Assurance.ISOLATED_LOCAL,
                                  Assurance.EXTERNAL_READ_ONLY)
    assert not assurance_at_least(Assurance.VISUAL_ADVISORY,
                                  Assurance.DETERMINISTIC_LOCAL)


def test_every_level_states_what_it_does_not_prove() -> None:
    """A level whose limits are unstated will be read as stronger than it is.

    Held as data rather than prose so this is enforceable: a new rung added
    without stating its limits fails here rather than shipping.
    """
    for level in Assurance:
        semantics = ASSURANCE_SEMANTICS[level]
        assert semantics["proves"], level.value
        assert semantics["does_not_prove"], level.value


def test_the_isolation_probe_is_honest_about_this_machine() -> None:
    capability = external_isolation()
    assert capability.available in (True, False)
    if not capability.available:
        # A refusal has to be actionable, and has to name the real obstacle.
        assert capability.level is Assurance.ISOLATED_LOCAL
        assert capability.reason
        assert capability.remedy
        assert best_available() is Assurance.ISOLATED_LOCAL
    else:
        assert capability.level is Assurance.EXTERNAL_READ_ONLY
        assert best_available() is Assurance.EXTERNAL_READ_ONLY


def test_a_cli_on_path_with_no_daemon_is_not_a_boundary(monkeypatch) -> None:
    """The common developer-machine case.

    A Docker CLI whose daemon is not running must not be reported as an
    available boundary; otherwise every contract requiring one fails at run
    time rather than at the honest refusal.
    """
    import subprocess

    from watch_skill.verify import isolation

    monkeypatch.setattr(isolation.shutil, "which",
                        lambda name: "/usr/bin/docker" if name == "docker" else None)

    def dead_daemon(*args, **kwargs):
        return subprocess.CompletedProcess(args, returncode=1, stdout="",
                                           stderr="cannot connect to daemon")

    monkeypatch.setattr(isolation.subprocess, "run", dead_daemon)
    capability = isolation.external_isolation()
    assert capability.available is False
    assert capability.level is Assurance.ISOLATED_LOCAL


def test_a_contract_demanding_more_than_the_machine_offers_is_refused(
    tmp_path,
) -> None:
    """Fail closed. The alternative is a verdict nobody can trust.

    Skipped rather than asserted when a container runtime *is* present,
    because then the demand is satisfiable and refusing would be the bug.
    """
    if external_isolation().available:
        pytest.skip("this machine can establish external_read_only, so a "
                    "contract requiring it is not expected to be refused")

    contract = VerificationContract(
        contract_id="needs-external",
        created_by="test",
        required_assurance=Assurance.EXTERNAL_READ_ONLY,
        checks=[Check(id="c", type="file_exists", params={"path": "x"})],
    ).freeze(created_by="test")

    with pytest.raises(ContractError) as excinfo:
        verify_run(contract, working_dir=tmp_path, isolated=True)
    assert excinfo.value.code == "verify.assurance_unavailable"
    detail = excinfo.value.details
    assert detail["required"] == "external_read_only"
    assert detail["available"] == "isolated_local"


def test_the_description_names_the_machines_position_on_the_ladder() -> None:
    report = describe()
    assert report["best_available"] in {level.value for level in Assurance}
    assert len(report["levels"]) == len(list(Assurance))
    assert report["external"]["available"] in (True, False)
    if not report["external"]["available"]:
        assert report["external"]["remedy"]
    assert all(entry["does_not_prove"] for entry in report["levels"])

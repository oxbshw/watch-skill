"""Self-healing dependency management, preflight checks, and health logging."""

from watch_skill.health.binaries import find_binary, managed_bin_dir
from watch_skill.health.doctor import CheckResult, DoctorReport, run_doctor

__all__ = ["CheckResult", "DoctorReport", "find_binary", "managed_bin_dir", "run_doctor"]

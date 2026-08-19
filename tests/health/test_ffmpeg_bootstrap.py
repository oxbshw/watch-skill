"""Portable ffmpeg bootstrap on every platform, not just Windows.

`bootstrap_ffmpeg_portable` used to raise `health.unsupported_platform`
anywhere but Windows, so `doctor` failed outright on Linux and macOS unless
ffmpeg was already installed — which the first real run of the install
matrix caught on both. These tests drive each platform branch against a
stub archive so the extraction logic is covered without a download.
"""
from __future__ import annotations

import io
import sys
import tarfile
import zipfile
from pathlib import Path

import pytest

from watch_skill.errors import DependencyError
from watch_skill.health import binaries

# Windows has no POSIX permission bits, and resolves executables by
# extension instead — the mode assertions only mean something elsewhere.
posix_only = pytest.mark.skipif(sys.platform == "win32", reason="POSIX permission bits")


def _linux_tarball(path: Path, names=("ffmpeg", "ffprobe")) -> None:
    """A BtbN-shaped tarball: binaries live under a versioned directory."""
    with tarfile.open(path, "w:xz") as tf:
        for name in names:
            data = f"#!/bin/sh\necho {name}\n".encode()
            info = tarfile.TarInfo(f"ffmpeg-master-latest-linux64-gpl/bin/{name}")
            info.size = len(data)
            info.mode = 0o755
            tf.addfile(info, io.BytesIO(data))


def _macos_zip(path: Path, name: str) -> None:
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr(name, f"#!/bin/sh\necho {name}\n")


@pytest.fixture()
def bin_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    from watch_skill import config

    monkeypatch.setenv("WATCHSKILL_DATA_DIR", str(tmp_path / "data"))
    config.reset_settings()
    return binaries.managed_bin_dir(create=True)


def test_linux_tarball_yields_both_binaries(bin_dir, monkeypatch) -> None:
    def fake_download(url: str, dest: Path, timeout: float = 600.0) -> Path:
        assert "linux" in url, f"asked for the wrong asset: {url}"
        _linux_tarball(dest)
        return dest

    monkeypatch.setattr(binaries, "_download_file", fake_download)
    monkeypatch.setattr(binaries.platform, "machine", lambda: "x86_64")

    ffmpeg, ffprobe = binaries._bootstrap_ffmpeg_linux(bin_dir)
    assert ffmpeg.is_file() and ffprobe.is_file()
    assert ffmpeg.name == "ffmpeg" and ffprobe.name == "ffprobe"


@posix_only
def test_extracted_linux_binaries_are_executable(bin_dir, monkeypatch) -> None:
    """Without the executable bit an extracted binary cannot be run."""
    monkeypatch.setattr(
        binaries, "_download_file", lambda url, dest, timeout=600.0: (_linux_tarball(dest), dest)[1]
    )
    monkeypatch.setattr(binaries.platform, "machine", lambda: "x86_64")
    ffmpeg, ffprobe = binaries._bootstrap_ffmpeg_linux(bin_dir)
    assert ffmpeg.stat().st_mode & 0o111, "ffmpeg is not executable"
    assert ffprobe.stat().st_mode & 0o111, "ffprobe is not executable"


def test_the_downloaded_archive_is_cleaned_up(bin_dir, monkeypatch) -> None:
    monkeypatch.setattr(
        binaries, "_download_file", lambda url, dest, timeout=600.0: (_linux_tarball(dest), dest)[1]
    )
    monkeypatch.setattr(binaries.platform, "machine", lambda: "x86_64")
    binaries._bootstrap_ffmpeg_linux(bin_dir)
    assert not list(bin_dir.glob("*.tar.xz")), "the tarball was left behind"


def test_an_incomplete_tarball_is_a_structured_error(bin_dir, monkeypatch) -> None:
    """Half a bootstrap must not look like a success."""
    monkeypatch.setattr(
        binaries,
        "_download_file",
        lambda url, dest, timeout=600.0: (_linux_tarball(dest, names=("ffmpeg",)), dest)[1],
    )
    monkeypatch.setattr(binaries.platform, "machine", lambda: "x86_64")
    with pytest.raises(DependencyError) as exc:
        binaries._bootstrap_ffmpeg_linux(bin_dir)
    assert exc.value.code == "health.bootstrap_failed"
    assert "ffprobe" in str(exc.value)


@pytest.mark.parametrize(
    ("machine", "expected"),
    [("x86_64", "linux64"), ("AMD64", "linux64"), ("aarch64", "linuxarm64"), ("arm64", "linuxarm64")],
)
def test_arch_tags_cover_both_cpus(machine: str, expected: str, monkeypatch) -> None:
    monkeypatch.setattr(binaries.platform, "machine", lambda: machine)
    assert binaries._linux_arch_tag() == expected


def test_an_unknown_cpu_says_so(monkeypatch) -> None:
    monkeypatch.setattr(binaries.platform, "machine", lambda: "riscv64")
    with pytest.raises(DependencyError) as exc:
        binaries._linux_arch_tag()
    assert exc.value.code == "health.unsupported_platform"
    assert "riscv64" in str(exc.value)


def test_macos_fetches_ffmpeg_and_ffprobe_separately(bin_dir, monkeypatch) -> None:
    """evermeet.cx ships one zip per tool, so both must be requested."""
    asked: list[str] = []

    def fake_download(url: str, dest: Path, timeout: float = 600.0) -> Path:
        tool = "ffprobe" if "ffprobe" in url else "ffmpeg"
        asked.append(tool)
        _macos_zip(dest, tool)
        return dest

    monkeypatch.setattr(binaries, "_download_file", fake_download)
    ffmpeg, ffprobe = binaries._bootstrap_ffmpeg_macos(bin_dir)

    assert asked == ["ffmpeg", "ffprobe"]
    assert ffmpeg.is_file() and ffprobe.is_file()
    assert not list(bin_dir.glob("*.zip")), "the zips were left behind"
    if sys.platform != "win32":
        assert ffmpeg.stat().st_mode & 0o111, "ffmpeg is not executable"


def test_every_extracted_linux_binary_is_asked_to_be_executable(
    bin_dir, monkeypatch
) -> None:
    """The same guarantee as the POSIX test, checkable on any platform.

    `test_extracted_linux_binaries_are_executable` asserts the *effect* of
    `chmod` and can only run where the filesystem has permission bits, which
    leaves the guarantee unverified on Windows — and it is release-blocking,
    because an extracted binary without the executable bit simply cannot run.

    This asserts the *request* instead: the real bootstrap runs against the
    same stub tarball, and every file it extracts must have been handed an
    exec-bearing mode. Nothing is mocked except the download the other tests
    already stub; the extraction path under test is the production one.
    """
    chmods: list[tuple[str, int]] = []
    real_chmod = Path.chmod

    def recording_chmod(self, mode, *args, **kwargs):
        chmods.append((self.name, mode))
        return real_chmod(self, mode, *args, **kwargs)

    monkeypatch.setattr(
        binaries, "_download_file",
        lambda url, dest, timeout=600.0: (_linux_tarball(dest), dest)[1])
    monkeypatch.setattr(binaries.platform, "machine", lambda: "x86_64")
    monkeypatch.setattr(Path, "chmod", recording_chmod)

    ffmpeg, ffprobe = binaries._bootstrap_ffmpeg_linux(bin_dir)

    granted = {name: mode for name, mode in chmods}
    for binary in (ffmpeg.name, ffprobe.name):
        assert binary in granted, (
            f"{binary} was extracted without any chmod; on POSIX it would "
            f"land un-runnable")
        assert granted[binary] & 0o111, (
            f"{binary} was chmod'ed to {granted[binary]:o}, which grants no "
            f"execute bit to anyone")
    # Owner execute is not enough on a shared install: the bit has to be there
    # for group and other too, which 0o755 gives and 0o700 does not.
    assert granted[ffmpeg.name] & 0o011, (
        f"only the owner may execute ffmpeg ({granted[ffmpeg.name]:o})")

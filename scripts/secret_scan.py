"""Scan the repository and the built artifacts for credential-shaped strings.

Two passes, because they answer different questions. The repository pass is
about what is committed. The artifact pass is about what actually ships — and
the wheel carries a 500 KB bundled JavaScript document that nobody reads line
by line, so a clean repo says very little about it.

Shape-based rather than name-based: a variable called `api_key` holding an
empty string is fine, and a bare forty-character token in a config file is not.

    python scripts/secret_scan.py                    # repo only
    python scripts/secret_scan.py --dist path/to/dist
"""
from __future__ import annotations

import argparse
import re
import subprocess
import sys
import tarfile
import zipfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]

PATTERNS: list[tuple[str, re.Pattern[bytes]]] = [
    ("anthropic key", re.compile(rb"sk-ant-[A-Za-z0-9_\-]{20,}")),
    ("openai key", re.compile(rb"\bsk-[A-Za-z0-9]{32,}")),
    ("github token", re.compile(rb"gh[pousr]_[A-Za-z0-9]{30,}")),
    ("aws access key", re.compile(rb"AKIA[0-9A-Z]{16}")),
    ("google api key", re.compile(rb"AIza[0-9A-Za-z_\-]{30,}")),
    ("slack token", re.compile(rb"xox[abprs]-[0-9A-Za-z\-]{10,}")),
    ("private key block", re.compile(rb"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
    ("hf token", re.compile(rb"\bhf_[A-Za-z0-9]{30,}")),
]

# Fixtures this project ships deliberately, to prove redaction works. Listed
# individually so the allowlist cannot quietly grow to cover a real leak.
# `AKIAIOSFODNN7EXAMPLE` is AWS's own published example key.
ALLOW: tuple[bytes, ...] = (
    b"sk-ant-sentinel",
    b"AKIAIOSFODNN7EXAMPLE",
    b"sk-abcdefghijklmnopqrstuvwxyz012345",
    b"ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    b"AIzaSyA1234567890abcdefghijklmnopqrstu",
    b"xoxb-1234567890-abcdefghijkl",
)

BINARY_SUFFIXES = {".pyc", ".png", ".jpg", ".jpeg", ".gif", ".webm", ".mp4",
                   ".woff", ".woff2", ".ico", ".xz", ".zip", ".onnx"}


def scan(label: str, data: bytes) -> list[tuple[str, str, str]]:
    found = []
    for name, pattern in PATTERNS:
        for match in pattern.finditer(data):
            hit = match.group(0)
            if any(ok in hit for ok in ALLOW):
                continue
            found.append((label, name, hit[:70].decode("utf-8", "replace")))
    return found


def scan_repo() -> tuple[int, list[tuple[str, str, str]]]:
    listing = subprocess.run(["git", "ls-files"], cwd=REPO, check=True,
                             capture_output=True, text=True)
    findings, scanned = [], 0
    for rel in listing.stdout.split("\n"):
        rel = rel.strip()
        if not rel:
            continue
        path = REPO / rel
        if not path.is_file() or path.suffix.lower() in BINARY_SUFFIXES:
            continue
        scanned += 1
        findings += scan(rel, path.read_bytes())
    return scanned, findings


def scan_dist(dist: Path) -> tuple[int, list[tuple[str, str, str]]]:
    findings, scanned = [], 0
    for wheel in sorted(dist.glob("*.whl")):
        with zipfile.ZipFile(wheel) as zf:
            for info in zf.infolist():
                if Path(info.filename).suffix.lower() in BINARY_SUFFIXES:
                    continue
                scanned += 1
                findings += scan(f"{wheel.name}:{info.filename}", zf.read(info))
    for sdist in sorted(dist.glob("*.tar.gz")):
        with tarfile.open(sdist) as tf:
            for member in tf.getmembers():
                if not member.isfile():
                    continue
                if Path(member.name).suffix.lower() in BINARY_SUFFIXES:
                    continue
                handle = tf.extractfile(member)
                if handle is None:
                    continue
                scanned += 1
                findings += scan(f"{sdist.name}:{member.name}", handle.read())
    return scanned, findings


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dist", type=Path, default=None)
    args = parser.parse_args()

    failed = False
    scanned, findings = scan_repo()
    print(f"repository: {scanned} tracked text files scanned")
    if findings:
        failed = True
        for label, kind, hit in findings[:30]:
            print(f"  FAIL {label} [{kind}] {hit}")
    else:
        print("repository: clean")

    if args.dist:
        scanned, findings = scan_dist(args.dist)
        print(f"artifacts:  {scanned} files scanned from {args.dist}")
        if findings:
            failed = True
            for label, kind, hit in findings[:30]:
                print(f"  FAIL {label} [{kind}] {hit}")
        else:
            print("artifacts:  clean")

    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

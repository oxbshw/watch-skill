"""Scan the repository and everything it ships for things that must not ship.

Three passes, because they answer different questions. The repository pass is
about what is committed. The Python artifact pass is about what a wheel
actually carries — a 500 KB bundled JavaScript document nobody reads line by
line, so a clean repo says very little about it. The npm pass opens each packed
tarball, because a `files` glob is a claim about contents and not a guarantee.

Shape-based rather than name-based: a variable called `api_key` holding an
empty string is fine, and a bare forty-character token in a config file is not.

Beyond credentials it looks for the things that leak without being secret — a
maintainer's home directory, a drive letter that exists on one machine, a
scope this project stopped publishing under.

**Nothing matched is ever printed.** A scanner that quotes its findings puts
the secret in a log, a terminal history and a CI transcript, which is three
more places than it was. Output is the file, the rule, and a redacted
classification: how long the match was and what it started with.

    python scripts/secret_scan.py                     # tracked tree
    python scripts/secret_scan.py --dist path/to/dist # + wheels and sdists
    python scripts/secret_scan.py --packed path/dir   # + npm tarballs
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
    ("npm token", re.compile(rb"npm_[A-Za-z0-9]{36}")),
    ("pypi token", re.compile(rb"pypi-AgEIcHlwaS5vcmc[A-Za-z0-9_\-]{10,}")),
    ("openrouter key", re.compile(rb"sk-or-v1-[A-Za-z0-9]{32,}")),
    ("bearer authorization header",
     re.compile(rb"""[Aa]uthorization\s*[:=]\s*["']?(?:Bearer|Basic)\s+[A-Za-z0-9._\-+/=]{16,}""")),
    ("npmrc auth line", re.compile(rb"//[^\s]+/:_authToken\s*=\s*[A-Za-z0-9._\-]{8,}")),
    ("certificate block", re.compile(rb"-----BEGIN CERTIFICATE-----")),
    ("encrypted private key", re.compile(rb"-----BEGIN ENCRYPTED PRIVATE KEY-----")),
    # Not secrets, and still must not ship: each names the machine a thing was
    # built on, and none of them resolves anywhere else.
    ("maintainer home", re.compile(rb"[A-Za-z]:[\\/]{1,2}Users[\\/]{1,2}[A-Za-z0-9._-]+")),
    ("posix home path", re.compile(rb"/(?:home|Users)/[A-Za-z0-9._-]+/")),
    ("maintainer drive",
     re.compile(rb"[A-Za-z]:[\\/]{1,2}watch-(?:manual|toolchain|workspace|smoke|rc-appdata)")),
    ("stale npm scope", re.compile(rb"@watchskill/")),
]

# Rules that only make sense for what is published, not for the working tree.
# A doc may legitimately quote an `.npmrc` line; a tarball may not contain one.
PACKED_ONLY: tuple[str, ...] = ("npmrc auth line", "certificate block")

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
    # The scanner's own patterns, so scanning this file is not a finding.
    b"secret_scan.py",
)

# One reviewed exemption per file and rule, with the reason it is deliberate.
#
# Never a pattern and never a directory: a blanket suppression is how a real
# leak arrives in a file that already had a reason to be quiet. A match in any
# other file, or a different rule in one of these, still fails.
DELIBERATE: dict[tuple[str, str], str] = {
    ("tests/bench/test_video_backend_adapter.py", "bearer authorization header"):
        "a parametrised fixture proving the redactor catches an Authorization header",
    ("workspace/tests/tenancy.test.mjs", "private key block"):
        "a fixture proving looksLikeSecret() catches a private key header",
    ("workspace/tests/content-identity.test.mjs", "maintainer drive"):
        "a hostile input proving no filesystem path reaches a client record",
    ("workspace/tests/read-plane-gateway.test.mjs", "maintainer drive"):
        "a hostile input proving the read plane strips paths",
    ("workspace/tests/library-index.test.mjs", "maintainer drive"):
        "hostile inputs proving the index stores no absolute path",
    ("workspace/tests/library-index.test.mjs", "maintainer home"):
        "hostile inputs proving the index stores no absolute path",
    ("workspace/tests/library-index.test.mjs", "posix home path"):
        "hostile inputs proving the index stores no absolute path",
    ("workspace/scripts/verify-portability.mjs", "maintainer drive"):
        "the gate that detects drive letters, which has to contain one to match it",
    ("workspace/scripts/lib/manual-paths.mjs", "maintainer drive"):
        "a module comment recording the default this file exists to have removed",
    ("workspace/scripts/ocr-corpus.py", "maintainer drive"):
        "a module comment recording the argument this script no longer requires",
    # The scanners themselves, which cannot state a rule without containing
    # the shape it matches. Per rule, so a file that legitimately holds a
    # certificate header is not thereby allowed to hold a live API key --
    # which is exactly what the file-wide allowlist these replaced permitted.
    ("scripts/secret_scan.py", "private key block"):
        "this scanner's own rule for a private key header",
    ("scripts/secret_scan.py", "encrypted private key"):
        "this scanner's own rule for an encrypted private key header",
    ("scripts/secret_scan.py", "stale npm scope"):
        "this scanner's own rule for the scope this project stopped publishing under",
    ("workspace/scripts/verify-publishable.mjs", "stale npm scope"):
        "the publishable gate refuses the old scope by name",
    ("workspace/scripts/verify-tracked-artifacts.mjs", "maintainer home"):
        "the tracked-artifacts gate matches this path shape, so it contains one",
    ("workspace/scripts/verify-tracked-artifacts.mjs", "posix home path"):
        "the tracked-artifacts gate matches this path shape, so it contains one",
    ("workspace/scripts/verify-tracked-artifacts.mjs", "maintainer drive"):
        "the tracked-artifacts gate matches this path shape, so it contains one",
    ("workspace/scripts/verify-tracked-artifacts.mjs", "stale npm scope"):
        "the tracked-artifacts gate refuses the old scope by name",
    ("workspace/tests/tracked-artifacts.test.mjs", "maintainer home"):
        "synthetic paths in the positive controls that prove that gate fires",
    ("workspace/tests/tracked-artifacts.test.mjs", "stale npm scope"):
        "a synthetic package name in the positive control for the scope rule",
    ("workspace/tests/path-privacy.test.mjs", "maintainer home"):
        "synthetic roots the redaction tests redact; the user is `someone`",
    ("workspace/tests/path-privacy.test.mjs", "posix home path"):
        "synthetic roots the redaction tests redact; the user is `someone`",
    ("workspace/tests/process-boundary.test.mjs", "npm token"):
        "a synthetic npm token (all `a`s) proving the env filter drops it",
    ("workspace/tests/process-boundary.test.mjs", "maintainer home"):
        "a synthetic profile path asserted never to reach a provider",
    ("workspace/tests/process-boundary.test.mjs", "posix home path"):
        "a synthetic profile path asserted never to reach a provider",
    ("tests/surfaces/test_bridge.py", "maintainer home"):
        "synthetic paths proving the Bridge redacts before framing",
    ("tests/surfaces/test_bridge.py", "posix home path"):
        "synthetic paths proving the Bridge redacts before framing",
    # The positive-control file: one synthetic value per rule, which is
    # what makes it trip every rule. Listed per rule rather than as one
    # file-wide entry, because this is precisely the file where giving
    # that up would be most tempting -- and a real credential pasted in
    # here would then have to trip a rule already named below, or the
    # scan still fails.
    ("tests/test_secret_scan.py", "anthropic key"):
        "one synthetic positive control per rule; every value is fabricated",
    ("tests/test_secret_scan.py", "aws access key"):
        "one synthetic positive control per rule; every value is fabricated",
    ("tests/test_secret_scan.py", "bearer authorization header"):
        "one synthetic positive control per rule; every value is fabricated",
    ("tests/test_secret_scan.py", "encrypted private key"):
        "one synthetic positive control per rule; every value is fabricated",
    ("tests/test_secret_scan.py", "github token"):
        "one synthetic positive control per rule; every value is fabricated",
    ("tests/test_secret_scan.py", "google api key"):
        "one synthetic positive control per rule; every value is fabricated",
    ("tests/test_secret_scan.py", "hf token"):
        "one synthetic positive control per rule; every value is fabricated",
    ("tests/test_secret_scan.py", "maintainer drive"):
        "one synthetic positive control per rule; every value is fabricated",
    ("tests/test_secret_scan.py", "maintainer home"):
        "one synthetic positive control per rule; every value is fabricated",
    ("tests/test_secret_scan.py", "npm token"):
        "one synthetic positive control per rule; every value is fabricated",
    ("tests/test_secret_scan.py", "openai key"):
        "one synthetic positive control per rule; every value is fabricated",
    ("tests/test_secret_scan.py", "openrouter key"):
        "one synthetic positive control per rule; every value is fabricated",
    ("tests/test_secret_scan.py", "posix home path"):
        "one synthetic positive control per rule; every value is fabricated",
    ("tests/test_secret_scan.py", "private key block"):
        "one synthetic positive control per rule; every value is fabricated",
    ("tests/test_secret_scan.py", "pypi token"):
        "one synthetic positive control per rule; every value is fabricated",
    ("tests/test_secret_scan.py", "slack token"):
        "one synthetic positive control per rule; every value is fabricated",
    ("tests/test_secret_scan.py", "stale npm scope"):
        "one synthetic positive control per rule; every value is fabricated",
}

BINARY_SUFFIXES = {".pyc", ".png", ".jpg", ".jpeg", ".gif", ".webm", ".mp4",
                   ".woff", ".woff2", ".ico", ".xz", ".zip", ".onnx"}

# Exemptions actually used on this run, so a stale one is visible rather than
# quietly protecting a file that no longer needs it.
EXEMPTED: list[tuple[str, str]] = []


def redact(hit: bytes) -> str:
    """Classify a match without reproducing it.

    Enough to find it — how long it was, and the few leading characters that
    identify the shape — and not enough to use. A scanner that prints what it
    found has moved the secret into a log rather than reported it.
    """
    head = hit[:4].decode("utf-8", "replace")
    return f"{len(hit)} chars, starts {head!r}, redacted"


def scan(label: str, data: bytes, packed: bool = False) -> list[tuple[str, str, str]]:
    found = []
    for name, pattern in PATTERNS:
        if name in PACKED_ONLY and not packed:
            continue
        hits = [m.group(0) for m in pattern.finditer(data)]
        hits = [hit for hit in hits if not any(ok in hit for ok in ALLOW)]
        if not hits:
            continue
        # A reviewed exemption applies to the working tree only. The same file
        # inside a tarball is something that shipped, and shipping it is the
        # question that pass exists to answer. Recorded only when it actually
        # suppressed something, so an exemption nothing needs shows up as
        # absent from the report rather than as a line nobody reads.
        if not packed and DELIBERATE.get((label, name)) is not None:
            EXEMPTED.append((label, name))
            continue
        for hit in hits:
            found.append((label, name, redact(hit)))
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


def scan_packed(packed: Path) -> tuple[int, list[tuple[str, str, str]]]:
    """Open every npm tarball and read what is actually inside it.

    A `files` glob is a claim about contents. This is the reading.
    """
    findings, scanned = [], 0
    for tarball in sorted(packed.glob("*.tgz")):
        with tarfile.open(tarball) as tf:
            for member in tf.getmembers():
                if not member.isfile():
                    continue
                name = Path(member.name).name
                # A dotfile has no useful suffix and is exactly what should
                # not be in here, so name it rather than skipping it.
                if name in {".env", ".npmrc"}:
                    findings.append((f"{tarball.name}:{member.name}",
                                     "published dotfile", "present, redacted"))
                    continue
                if Path(member.name).suffix.lower() in BINARY_SUFFIXES:
                    continue
                handle = tf.extractfile(member)
                if handle is None:
                    continue
                scanned += 1
                findings += scan(f"{tarball.name}:{member.name}", handle.read(), packed=True)
    return scanned, findings


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dist", type=Path, default=None)
    parser.add_argument("--packed", type=Path, default=None)
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

    if args.packed:
        scanned, findings = scan_packed(args.packed)
        print(f"npm packs:  {scanned} files scanned from {args.packed}")
        if findings:
            failed = True
            for label, kind, hit in findings[:30]:
                print(f"  FAIL {label} [{kind}] {hit}")
        else:
            print("npm packs:  clean")

    used = sorted(set(EXEMPTED))
    unused = sorted(set(DELIBERATE) - set(used))
    if used:
        print(f"exempted:   {len(used)} reviewed fixture(s), reasons in DELIBERATE")
        for label, kind in used:
            print(f"  allow {label} [{kind}] - {DELIBERATE[(label, kind)]}")

    if unused:
        # Not a failure: a pass that scanned no repository legitimately uses
        # none of them. It is worth saying, because an exemption that survives
        # the thing it was written for is one nobody will question later.
        print(f"stale:      {len(unused)} exemption(s) matched nothing this run")
        for label, kind in unused:
            print(f"  unused {label} [{kind}]")

    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

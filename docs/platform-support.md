# Platform support

What has been run, on what, and what has not been run at all. The distinction
this document keeps is between *supported* — exercised, with a result — and
*expected to work* — portable by construction, never executed. The second is a
reasonable engineering belief. It is not evidence, and it is not labelled as
though it were.

## Validated on this machine

| | |
| --- | --- |
| Operating system | Windows 10 Pro 19045 (x64) |
| Node | v22.18.0 |
| pnpm | 10.29.1 |
| Electron | 33.4.11 |
| DSH | 0.1.1-rc.2 @ `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e` |

One discrepancy, stated rather than smoothed over: `engines` in `package.json`
declares `^22.19.0 || >=24.0.0`, and the machine this release candidate was
validated on runs 22.18.0 — a patch below the declared floor. Everything passes
there, but the declared contract is what CI holds to, so CI pins 22.19.0. If the
floor is wrong it should be lowered deliberately; it has not been lowered to make
a local run look compliant.

## Status by platform

| Platform | Web | Desktop | Gates | Basis |
| --- | --- | --- | --- | --- |
| Windows x64 | run | run | pass | executed here, repeatedly, this pass |
| Linux x64 | not run | not run | not run | CI job defined, never yet executed |
| macOS arm64 | not run | not run | not run | CI job defined, never yet executed |
| macOS x64 | not run | not run | not run | CI job defined, never yet executed |

"Not run" is the honest word. The CI matrix in `.github/workflows/ci.yml`
defines all three, and running it requires pushing to a remote — which this
work is not permitted to do — so no Linux or macOS result exists to report.

## What makes the other platforms plausible

Not proof. Reasons.

- `verify:portability` scans all shipped source under `packages/` and `apps/`
  for drive letters, absolute POSIX paths, hardcoded `.exe`, kill-by-name,
  hardcoded shells, backslash separators, and unguarded `HOME`/`USERPROFILE`.
  It runs clean over 147 files. It found a real Windows-only defect in the
  Desktop main process — hardcoded `G:/watch-manual` paths — which is now
  derived from `app.getPath()`.
- Every runtime path is built with `join()` from `node:path`, and every
  application directory comes from Electron's own `app.getPath()`, which is
  defined per platform by Electron rather than by us.
- Nothing in the shipped tree spawns a shell or a platform binary.
- The gate suite is pure Node with no native dependency outside Electron.

## Known platform-specific behaviour

- **Windows.** Electron is a GUI-subsystem binary, so a launched Desktop
  process writes nothing to stdout; the QA capture tool logs to a file instead.
  Extra `argv` breaks Electron's entry resolution entirely, so the capture tool
  is configured by environment variable.
- **Linux.** Electron needs a display server. CI wraps the Desktop smoke in
  `xvfb-run`. There is no platform gatekeeper, so a signature is for the person
  verifying a download rather than for the operating system.
- **macOS.** Signing alone has not been sufficient since Catalina: an
  un-notarized build is refused by Gatekeeper. Notarization needs network
  access and Apple's service, so it cannot be done offline, and hardened
  runtime must be enabled or notarization is rejected.

## External requirements, unmet

These cannot be closed in this repository, and no amount of further work here
will change that.

| Requirement | Blocks | Why it cannot be met here |
| --- | --- | --- |
| macOS machine or runner | macOS Web/Desktop validation | no macOS available |
| Linux machine or runner | Linux Web/Desktop validation | no Linux available; a container would not exercise native Desktop behaviour |
| Push access to a remote | any CI result at all | pushing is explicitly out of scope for this work |
| Windows Authenticode certificate | signed Windows release | a real certificate must be purchased; a generated one is worthless and is never created |
| Apple Developer ID + notarization account | signed, notarized macOS release | requires a paid Apple Developer account and Apple's online service |
| GPG signing key | signed Linux artifacts | requires a key the release owner controls |

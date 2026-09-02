# Platform support

What has been run, on what, and what has not been run at all. Supported means
exercised with a recorded result. Expected to work means portable by
construction and never executed; that is a reasonable engineering position, but
it is not evidence and is not labelled as such here.

## Validated on this machine

| | |
| --- | --- |
| Operating system | Windows 10 Pro 19045 (x64) |
| Node | v22.18.0 |
| pnpm | 10.29.1 |
| Electron | 33.4.11 |
| DSH | 0.1.1-rc.2 @ `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e` |

One discrepancy worth stating rather than smoothing over: `engines` declares
`^22.19.0 || >=24.0.0`, and this machine runs 22.18.0, a patch below the
declared floor. Everything passes there, but CI pins 22.19.0 because the
declared contract is what CI should hold to. If the floor is wrong it should be
lowered deliberately; it has not been lowered to make a local run compliant.

## Status by platform

| Platform | Web | Desktop | Gates | Basis |
| --- | --- | --- | --- | --- |
| Windows x64 | required | required | required | `workspace / platform (windows-latest)` |
| Linux x64 | required | required under Xvfb | required | `workspace / platform (ubuntu-latest)` |
| macOS | required | required | required | `workspace / platform (macos-latest)` |

The matrix in `.github/workflows/workspace-ci.yml` runs all three for every
Workspace change. Platform support for a candidate is established only by the
checks attached to that exact commit; this page deliberately does not preserve
an old green result as a claim about a newer tree.

## What makes the other platforms plausible

Reasons, not proof.

`verify:portability` scans all shipped source under `packages/` and `apps/` for
drive letters, absolute POSIX paths, hardcoded `.exe`, kill-by-name, hardcoded
shells, backslash separators, and unguarded `HOME`/`USERPROFILE`. It runs clean
over 149 files. It found a real Windows-only defect in the Desktop main process,
where application data, DSH home and the log directory were hardcoded to a
drive letter on the machine they were written on; those now come from
`app.getPath()`.

Every runtime path is built with `join()` from `node:path`, every application
directory comes from Electron's `app.getPath()`, nothing in the shipped tree
spawns a shell or a platform binary, and the gate suite is pure Node with no
native dependency outside Electron.

## Known platform-specific behaviour

Windows: Electron is a GUI-subsystem binary, so a launched Desktop process
writes nothing to stdout and the QA capture tool logs to a file instead. Extra
`argv` breaks Electron's entry resolution, so the capture tool is configured by
environment variable.

Linux: Electron needs a display server, and CI wraps the Desktop smoke in
`xvfb-run`. There is no platform gatekeeper, so a signature is for the person
verifying a download rather than for the operating system.

macOS: signing alone has not been sufficient since Catalina. An un-notarized
build is refused by Gatekeeper, notarization needs network access to Apple's
service, and hardened runtime must be enabled or notarization is rejected.

## External requirements, unmet

These cannot be closed from inside this repository.

| Requirement | Blocks | Why |
| --- | --- | --- |
| Windows Authenticode certificate | signed Windows release | must be purchased; a generated one proves nothing and is never created |
| Apple Developer ID + notarization | signed, notarized macOS release | needs a paid Apple Developer account and Apple's online service |
| GPG signing key | signed Linux artifacts | needs a key the release owner controls |

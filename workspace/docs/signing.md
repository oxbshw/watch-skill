# Signing

This document names the secrets a signed release needs. It contains no secret
values, and neither does the gate that checks them: `scripts/verify-signing.mjs`
asserts that a variable is set and never reads what is in it, so running it
cannot leak a certificate or a password into a log or a crash dump.

## The rule

A release build with missing credentials fails. It does not fall back to
producing an unsigned artifact.

That default matters because the opposite one is how an unsigned build reaches
someone who believes it was signed. A development build is allowed to be
unsigned provided it says so in its own metadata.

No certificate is generated to get past the gate. A self-signed certificate
produced to make a check go green proves nothing, and committing one would be
worse than having none.

## Required secrets

### Windows, Authenticode

| Variable | What it is |
| --- | --- |
| `WATCH_WIN_CERT_PFX_BASE64` | the code-signing certificate, a `.pfx` encoded base64 |
| `WATCH_WIN_CERT_PASSWORD` | the password protecting that `.pfx` |

Timestamping is required, at `http://timestamp.digicert.com`. A signature
without a countersignature stops verifying when the certificate expires: the
build does not change, but one day it stops being trusted.

### macOS, Developer ID and notarization

| Variable | What it is |
| --- | --- |
| `WATCH_MAC_CERT_P12_BASE64` | the Developer ID Application certificate, `.p12` encoded base64 |
| `WATCH_MAC_CERT_PASSWORD` | the password protecting that `.p12` |
| `WATCH_APPLE_ID` | the Apple ID that submits for notarization |
| `WATCH_APPLE_APP_PASSWORD` | an app-specific password, never the account password |
| `WATCH_APPLE_TEAM_ID` | the ten-character team identifier |

Signing alone is not sufficient. Since Catalina, Gatekeeper refuses an
un-notarized build, notarization requires network access to Apple's service, and
hardened runtime must be enabled or notarization is rejected outright.

### Linux, detached GPG signature

| Variable | What it is |
| --- | --- |
| `WATCH_GPG_PRIVATE_KEY` | the ASCII-armoured private key |
| `WATCH_GPG_PASSPHRASE` | its passphrase |

Linux has no platform gatekeeper. The signature is for the person verifying a
download, so its value depends on the public key being published somewhere the
verifier already trusts.

## What the gate checks

Run on every platform, on every CI run, and as part of `npm run check`:

```bash
npm run verify:signing
```

Independently of any credential it validates that `build.appId` is a
reverse-DNS identifier (a signature is bound to it), that `build.productName` is
exactly `DeepWatch`, and that `build.win.icon`, `build.mac.icon` and
`build.linux.icon` are all set.

Then, for the current platform, it checks whether each secret above is present.
Absent credentials on a development build are a note. Absent credentials with
`--release` are an error:

```bash
node scripts/verify-signing.mjs --release
```

Observed on Windows with no credentials configured, exit code 1:

```
watch: the signing configuration is not release-ready

  a release build was requested and 2 credential(s) are missing: WATCH_WIN_CERT_PFX_BASE64, WATCH_WIN_CERT_PASSWORD

watch: no fake certificate is ever generated to get past this. Supply the real credentials, or build without --release and label it unsigned.
```

## Current state

No signing credential of any kind is configured, and none can be obtained from
inside this repository. Every build produced so far is an unsigned development
build and is labelled as one.

Closing this needs three purchases or enrolments that are external by nature: a
Windows Authenticode certificate, a paid Apple Developer account with
notarization, and a GPG key the release owner controls. See
[platform-support.md](platform-support.md) for the full external-requirement
list.

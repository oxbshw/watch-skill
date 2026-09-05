# @deepwatch/dsh-sdk

The third-party Watch capability developer path — declare, probe, observe, request

Part of **DeepWatch** — the Web and Desktop agent product built on the
official [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
packages and powered by [Watch Skill](https://github.com/oxbshw/watch-skill) for perception, evidence,
memory and independent verification.

## Exports

- `@deepwatch/dsh-sdk`
- `@deepwatch/dsh-sdk/client-example`

## Peers

Provided by the host rather than installed here:

- `react@^18.2.0` — optional

## Install

```sh
npm install @deepwatch/dsh-sdk
```

Rarely on its own. [`@deepwatch/dsh-bundle`](https://github.com/oxbshw/watch-skill/tree/main/workspace/packages/watch/bundle#readme)
composes this package with the rest of DeepWatch and is what a profile
normally depends on; installing this one directly is for embedding a
single piece in a composition you control.

## Requirements

- Node `^22.19.0 || >=24.0.0`
- The peers above, supplied by the host composition

## Stability

`0.1.0` — a stable release.

## Side effects

Importing a module from this package evaluates no side effects, so a
bundler may drop what a build does not use. Mounting it in a host is a
separate matter: what it then reads or writes is governed by the
workspace boundary and the host's permissions, not by this flag.

## Where this fits

These packages are composed together; installing one on its own is rarely
what you want. The whole picture, the gates it has to pass, and how to run
DeepWatch is in the
[workspace README](https://github.com/oxbshw/watch-skill/tree/main/workspace#readme).

## Attribution

Built on DeepSeek Harness · Powered by Watch Skill

DeepWatch and Watch Skill are independent projects and are not affiliated
with or endorsed by DeepSeek. MIT licensed; third-party notices are in
[THIRD_PARTY_NOTICES.md](https://github.com/oxbshw/watch-skill/blob/main/workspace/THIRD_PARTY_NOTICES.md).

# Third-party notices

DeepWatch is a downstream distribution of DeepSeek Harness. The upstream
project is not vendored: it is consumed as published npm packages pinned in
[`upstream/deepseek-harness.lock`](upstream/deepseek-harness.lock), and a
source checkout is used only for audit and inventory generation.

## DeepSeek Harness

- Project: https://github.com/deepseek-ai/deepseek-harness
- Baseline: `0.1.1-rc.2` at commit `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`
- License: MIT

```
MIT License

Copyright (c) 2026 DeepSeek

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

The upstream LICENSE text above is reproduced from the pinned commit. When the
baseline moves, the upstream-bump report regenerates this section along with
the dependency and SBOM diff.

## Cordis

Vendored by DeepSeek Harness and consumed here as `@deepseek-ai/cordis` 4.0.1.
Licensed MIT; see the package's own LICENSE in the installed tree.

## The Harness runtime closure, and one LGPL component

`@deepwatch/cli` declares `@deepseek-ai/dsh` as an **exact optional peer
dependency**. It is bundled into no DeepWatch package. `deepwatch setup`
describes the download, asks, and then installs exactly
`@deepseek-ai/dsh@0.1.1-rc.2` from `https://registry.npmjs.org` into DeepWatch's
own home directory. The user's package manager fetches it, from its publishers,
under their terms.

That closure reaches `sharp`, by way of `@deepseek-ai/dsh-base` and
`@deepseek-ai/dsh-attachment-local`. sharp's per-platform packages declare
**`Apache-2.0 AND LGPL-3.0-or-later`**, and reading one shows why:
`@img/sharp-win32-x64` contains `libvips-42.dll` and `libvips-cpp-8.18.6.dll`
beside sharp's `.node` addon, while its own `LICENSE` file carries only the
Apache-2.0 text. The Apache half is sharp's glue code; the LGPL half is libvips.

Twenty-six packages in that closure carry a licence outside this distribution's
allowlist: sharp's platform binaries and the `@img/sharp-libvips-*` payloads,
all of them LGPL by way of libvips. Each is reviewed individually in
`inventory/licence-review.json`: what it is, how it arrives, and whether
DeepWatch redistributes it. `scripts/gen-sbom.mjs` fails on any package that is
neither allowed nor reviewed, and on any reviewed package that declares a
licence the review does not list. The allowlist itself was not widened to make
that gate pass.

The review had to be written from more than one machine. A package manager
installs only the current platform's optional packages, so a licence is
readable only where the package is installed: `@img/sharp-libvips-linux-x64`
declares `LGPL-3.0-or-later` on Linux and nothing at all on Windows, and
`@deepseek-ai/node-addon-landlock-run-linux-x64` declares `BSD-3-Clause` where
it exists at all. Every value recorded is one some platform actually reports,
and the SBOM records the same one on every machine rather than whichever the
generator's host happened to see.

**One decision remains open, and it is the project owner's to make.** DeepWatch
redistributes no libvips binary today, so no LGPL obligation attaches to
anything published from this repository. A future Desktop installer that
*bundled* the Harness rather than fetching it would be redistributing those
binaries, and would take on the LGPL-3.0-or-later relinking obligation. That is
a packaging decision to settle before such an installer ships.

## Naming

The DeepSeek name is not part of this product's name, and DeepSeek marks are
not shipped. Attribution to the upstream project is required and visible:

> Built on DeepSeek Harness · Powered by Watch Skill

DeepWatch and Watch Skill are independent projects and are not affiliated with
or endorsed
by DeepSeek.

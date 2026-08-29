# Third-party notices

Watch Workspace is a downstream distribution of DeepSeek Harness. The upstream
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

## Naming

The DeepSeek name is not part of this product's name, and DeepSeek marks are
not shipped. Attribution to the upstream project is required and visible:

> Built on DeepSeek Harness · Extended by Watch Skill

Watch Skill is an independent project and is not affiliated with or endorsed
by DeepSeek.

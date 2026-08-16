# Disk cleanup receipt

Staged cleanup performed under an explicit authorization limited to
reproducible caches, obsolete build output, incomplete downloads, and
temporary project/test artifacts. No path outside those categories was
touched. Paths are given by category and drive letter only.

## Before

| Drive | Free | Total |
| --- | --- | --- |
| C: (caches, models, Playwright) | **3.92 GiB** | 118.67 GiB |
| F: (repository, virtualenv) | **0.85 GiB** | 49.34 GiB |
| G: | 47.74 GiB | 127.78 GiB |
| H: | 26.32 GiB | 53.38 GiB |

RAM 2.53 GiB free of 7.90 GiB. Working tree clean at `efb61bc`.

## Reclaimed by category

| Tier | Category | Reclaimed |
| --- | --- | --- |
| 1 | Repository caches — `__pycache__` (56), `.pytest_cache`, `.ruff_cache`, untracked `dist/` (wheel + sdist + `.skill`), `app/dist` | 11.7 MiB |
| 2 | Vite `node_modules` (removed ahead of the Next.js dependency install; `package.json` and lockfile v3 validated first) | 91 MiB |
| 3 | npm cache (`npm cache clean --force`) | ~1.5 GiB |
| 5 | Project-owned temp: 402 directories — `pytest-of-hp` (613.8 MiB), `watch-skill-*` fixtures (~330), `ws-clean-install`, `ws-final-install`, `ws-final2`, `observer example data`, `clip debug`, `obs debug` | 873.3 MiB |
| — | **Total** | **≈ 2.5 GiB** |

Every temp directory was age-checked (nothing modified within 5 minutes) and
matched against an explicit list of prefixes this project creates. No wildcard
was applied to the temporary directory as a whole.

## After

| Drive | Free | Change |
| --- | --- | --- |
| C: | **6.35 GiB** | +2.43 GiB |
| F: | **0.94 GiB** | +0.09 GiB |

RAM 3.11 GiB free of 7.90 GiB.

## The 12 GiB target was not met, and could not be

**C: + F: = 7.29 GiB free.** The approved categories are now exhausted:

| Remaining candidate | Size | Why it stayed |
| --- | --- | --- |
| `uv` cache | 499.5 MiB | `uv cache prune` refused — the active virtualenv holds an editable entry. That is the tool protecting a working environment, and forcing it would break the venv. |
| pip cache | 13.7 MiB | Negligible; pip is not installed in this uv-managed venv. |
| Playwright browsers | 688.5 MiB | **Only one revision exists** (`chromium-1228`), and it is the revision Playwright 1.61.0 resolves to. There is no unused older revision to prune. |
| Hugging Face cache | 74.6 MiB | `Systran/faster-whisper-tiny` — explicitly preserved. |
| `.venv` | 816 MiB | The active environment. |

The shortfall is not a cleanup failure. **F: holds ~48 GiB of content that is
neither the repository nor any approved category** — user data outside the
authorization. Reaching 12 GiB on the working drives would require deleting
it, which the safety boundary forbids and which was not authorized.

G: (47.74 GiB) and H: (26.32 GiB) have ample space and were already above the
target before cleanup; they are not where the repository, virtualenv, or
caches live.

## Preserved (verified after cleanup)

- `.git` — HEAD `efb61bc`, 38 commits ahead of `origin/main`, working tree clean,
  `git fsck --connectivity-only` reports only pre-existing dangling objects
  from an earlier `--amend`. **No `gc`, `prune`, or reflog expiry was run.**
- All source, tests, documentation, and `docs/assets/workspace/` (5 tracked files).
- `Systran/faster-whisper-tiny`, 74.6 MiB — confirmed present, `faster_whisper` imports.
- Playwright `chromium-1228` — confirmed present and resolved by the installed package.
- The active `.venv`.
- Project configuration and lockfiles.

## Incomplete downloads removed

None found. No `.incomplete`, `.partial`, or failed model download existed in
any inventoried cache.

## Post-cleanup verification

| Check | Result |
| --- | --- |
| Python smoke (`test_config`, `test_policy`, `entities`) | 52 passed |
| Browser smoke (`test_browser_pool`) | 14 passed |
| ASR model presence probe | cached, importable |
| Git integrity | intact |

## Machine, re-measured

| | |
| --- | --- |
| CPU | Intel Core i5-4300M @ 2.60 GHz, 4 logical (2 cores + HT), 2013 |
| RAM | 7.90 GiB total, 3.11 GiB free |
| Pagefile | 6144 MiB |
| GPU | Intel HD Graphics 4600, 1 GiB shared — no CUDA |
| Free disk (work drives) | C: 6.35 GiB, F: 0.94 GiB |

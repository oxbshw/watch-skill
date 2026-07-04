## What

<!-- One paragraph: what changes and why. Link the issue if there is one. -->

## Checklist

- [ ] `uv run pytest -q -m "not network"` is green locally
- [ ] New behavior has a test (live bugs get a regression test *before* the fix counts)
- [ ] Errors raised are structured (`code` + `message` + actionable `fix`)
- [ ] `core/` does not import `surfaces/`
- [ ] Windows-safe paths (`pathlib`, spaces-in-paths tolerated)
- [ ] Privacy invariants untouched (video never leaves the machine; cloud STT stays opt-in) — or SECURITY.md updated with reviewer sign-off
- [ ] Non-obvious decisions logged in `docs/DECISIONS.md`

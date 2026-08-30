# Running the applications

Both apps are running now. This is how to get them back after a reboot, and what
each command is actually doing — because when one of them fails, the useful thing
is knowing which of the three processes stopped.

## What is running

Neither application is a self-contained binary. Each is a small tree:

```
Watch Web                          Watch Desktop
  browser                            Electron window
    └─ DSH Web Host   (node)           └─ DSH Web Host   (node)   ← supervised child
         └─ Watch Core (python)             └─ Watch Core (python)
```

The DSH Host is upstream's, unmodified, with the Watch bundle composed in as a
patch layer. Watch Core is the Python engine, spawned by the Host as a stdio
child — it holds no socket and the browser never reaches it. **Desktop is the
same web application**, loaded from a Host that the Electron process starts and
supervises itself. There is no second UI, which is why the two windows look
identical: they are.

That also means each running application has **its own Watch Core**. Two apps
running means two `watch-skill` processes, and that is correct.

## Web

```bash
DSH_HOME="<manual root>/dsh-home" node "<harness>/lib/bin.js" --profile web --patch "<manual root>/dsh-home/watch-manual.patch.yml" --no-open --host 127.0.0.1 --port 8931
```

`scripts/manual-profile.mjs` prints that line with this machine's own paths
filled in when it finishes, and writes them to `<manual root>/manual-profile.json`
so it can be read back later.

Then open http://127.0.0.1:8931.

`--host 127.0.0.1` is not a default worth losing: it is what keeps the Host off
every other interface. `--patch` layers the manual-test overlay (Watch Core's
executable path, the memory directory, offline-only) over the stock profile
without editing it.

Ready when the log prints `dsh web: http://127.0.0.1:8931`.

## Desktop

```bash
cd apps/desktop && npx electron .
```

Ready when the log prints a `WATCH_DESKTOP_READY` line with `"step":"ready"`.
It picks its own port; the line carries the one it got.

If Electron cannot find a system Node, set `WATCH_NODE` to a Node 22 executable.
It deliberately does **not** use Electron's bundled Node — that is Node 20, and
it resolves pnpm's symlinked layout differently from the Node the profile was
installed with, which fails with `ERR_MODULE_NOT_FOUND` for packages that are
plainly present on disk.

## Rebuilding the profile from nothing

```bash
node scripts/manual-profile.mjs && node scripts/seed-manual-fixtures.mjs
```

The first builds `<manual root>/dsh-home` — a stock DSH `web` profile with the
Watch bundle installed and the overlay written. The second seeds the demo data:
memory records through the real service at real origins, and the fixture files
the checklist refers to. Both are idempotent.

`<manual root>` is the platform's own state directory plus `watch-manual`, and
`WATCH_MANUAL_ROOT` moves all of it somewhere else — a scratch directory, a
different disk, wherever this machine has room. Nothing here writes outside it.

## Visual QA evidence

Screenshots come from the real running application, captured with Electron —
already a dependency, so nothing new is installed and nothing leaves the
machine:

```bash
WATCH_QA_URL=http://127.0.0.1:8931 WATCH_QA_SESSION=<session-id> electron scripts/qa-screenshots.mjs
```

Two details that cost a while to find, both worth knowing before you run it:

- **Configuration goes through the environment, not argv.** Passing extra
  arguments to `electron.exe` stops it resolving the entry at all — the module
  never parses and the run is indistinguishable from a silent success.
- **Output goes to `capture.log`, not stdout.** `electron.exe` on Windows is a
  GUI-subsystem binary; it detaches from the console and stdout is lost.

`WATCH_QA_SESSION` should name a session that has history. The mode tabs live in
the session header, and DSH hides that chrome while a session is blank — a fresh
empty session shows no tabs, which looks exactly like the registrations having
failed.

## When something is wrong

Logs are in `<manual root>/logs`. `web.log`, `desktop-main.log` (the Electron
process), `desktop-host.log` (its supervised Host).

Work down the tree, because the symptom is usually one level below where it
shows:

1. **Browser shows nothing** — is the Host listening?
   `netstat -ano | grep 127.0.0.1:8931`
2. **Host is up but the app is broken** — check `web.log` for a plugin tree
   failure. A missing `inject` or a duplicate row id both surface here.
3. **App works but Watch surfaces are empty** — is Core alive?
   `Get-Process watch-skill`. One per running Host.

Two failures worth recognising on sight, because both were hit getting here:

- **`duplicate loader entry id`** — a patch used `- insert:` on an id that
  already exists. `insert` *adds* a row; overriding one means targeting it
  directly with a bare `- id:`.
- **`cannot get property "…" without inject`** — a plugin's default export is a
  bare function rather than an object. Cordis reads `inject` off the resolved
  default, so a named export beside it is invisible.

Desktop failing to start its Host is not a crash: it opens in **safe mode** on
the shipped local renderer, carrying the reason. If you see that window, the
reason is already on screen and in `desktop-main.log`.

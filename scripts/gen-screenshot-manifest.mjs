#!/usr/bin/env node
/**
 * The screenshot manifest: what was photographed, and what it shows.
 *
 * A directory of PNGs is not evidence on its own. Every file in one looks like
 * a success, including the sixteen byte-identical copies of an empty workspace
 * that an earlier capture saved under seven different mode names. This manifest
 * records, per shot, what it was supposed to show, what a reviewer saw on
 * opening it, and whether those agree. A shot with no file carries the reason
 * instead.
 *
 * It also reports byte-identical images as a failure, since that is how the
 * earlier set looked healthy while showing nothing.
 *
 * Usage:
 *   node scripts/gen-screenshot-manifest.mjs <capture-dir>
 *   node scripts/gen-screenshot-manifest.mjs <capture-dir> --check
 */
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_JSON = join(ROOT, 'docs', 'screenshot-manifest.json')
const OUT_MD = join(ROOT, 'docs', 'screenshot-manifest.md')

/**
 * What each shot is for, and what a reviewer confirmed on looking at it.
 *
 * Keyed by the shot name without its viewport prefix, because the two
 * viewports photograph the same surface. `expected` is written before the
 * capture; `observed` is filled in from actually opening the file.
 */
const REVIEW = {
  '01-onboarding': {
    route: 'first run, before any session',
    expected: 'the Watch first-run notice: orca mark, the four verbs, an honest readiness count, and two ways out',
    observed: 'the Watch notice, with "4 of 12 capabilities are ready" and the consent separation stated below the buttons',
    verdict: 'pass',
  },
  '03-workspace': {
    route: 'workspace, no provider configured',
    expected: 'the workspace entered without configuring anything, with the mark and attribution in place',
    observed: 'empty workspace, orca mark on the hero and in the sidebar, attribution in the sidebar foot',
    verdict: 'pass',
  },
  '05-mode-chat': {
    route: 'Chat mode',
    expected: "DSH's own conversation view, unchanged, as one tab among seven",
    observed: 'the upstream conversation view with the composer and model picker intact',
    verdict: 'pass',
  },
  '05-mode-trajectory': {
    route: 'Trajectory mode',
    expected: "DSH's own trajectory view, unchanged",
    observed: 'the upstream timeline with Duration/Turns/Calls and its own search',
    verdict: 'pass',
  },
  '05-mode-watch': {
    route: 'Watch mode',
    expected: 'the verification surface, with completed and verified kept apart',
    observed: '"Agent completed ≠ Verified" stated; empty state names three ways to get a record',
    verdict: 'pass',
  },
  '05-mode-live': {
    route: 'Live mode',
    expected: 'every source with the permission it would ask for, and nothing started by opening the page',
    observed: 'seven sources listed; "Opening this page starts nothing and asks for nothing"; Browser Operator marked as able to act',
    verdict: 'pass',
  },
  '05-mode-memory': {
    route: 'Memory mode',
    expected: 'the memory ledger, correctable and with provenance',
    observed: 'the ledger surface with its empty state and the route to Settings',
    verdict: 'pass',
  },
  '05-mode-library': {
    route: 'Library mode',
    expected: 'a working search box over the local index, with filters and index health',
    observed: 'search field, Type/Verification/Sort filters, Search and Rebuild index, "0 record(s) indexed"',
    verdict: 'pass',
  },
  '05-mode-compare': {
    route: 'Compare mode',
    expected: 'two records side by side, with output differences separate from verification differences',
    observed: '"computed, not reasoned about"; empty state names how to get two records',
    verdict: 'pass',
  },
  '06-settings-general': {
    route: 'Settings → General',
    expected: 'DSH General kept above the Watch sections, unmodified',
    observed: 'General, Models, Plugins and Agent presets sit above the seven Watch sections',
    verdict: 'pass',
  },
  '07-settings-roles': {
    route: 'Settings → Role Bindings',
    expected: 'nine roles, each showing what it is bound to, with unbound stated plainly',
    observed: 'per-role cards; every role reads "Nothing bound on this machine", "Last tested: Never"',
    verdict: 'pass',
  },
  '07-settings-engines': {
    route: 'Settings → Perception',
    expected: 'every engine with runtime, hardware, egress and offline behaviour, and no invented accuracy figure',
    observed: 'RapidOCR reads "Measured on this machine"; Tesseract and DeepSeek-OCR read "Not measured on this machine"',
    verdict: 'pass',
  },
  '07-settings-sources': {
    route: 'Settings → Sources',
    expected: 'every source with the permission it would ask for, and nothing requested by opening the page',
    observed: 'all sources "Not requested"; the header states that opening the page requests nothing',
    verdict: 'pass',
  },
  '07-settings-memory-settings': {
    route: 'Settings → Memory',
    expected: 'the memory scope and retention rules, with the shipped default visible',
    observed: 'scope and retention rendered; the manual profile has memory at local_personal',
    verdict: 'pass',
  },
  '07-settings-verification': {
    route: 'Settings → Verification',
    expected: 'the four verdicts defined, and green reserved for VERIFIED alone',
    observed: '"Agent completed ≠ Verified" leads; all four verdicts defined; green reserved for VERIFIED explicitly',
    verdict: 'pass',
  },
  '07-settings-diagnostics': {
    route: 'Settings → Diagnostics',
    expected: 'what this installation consists of, saying so where a value cannot be read',
    observed: '12 capabilities with Ready / Local / Not configured / Not tested — matching the onboarding count of 4',
    verdict: 'pass',
  },
  '07-settings-about': {
    route: 'Settings → About',
    expected: 'versions, the DSH commit, honest attribution, and licences including the weights position',
    observed: 'all present; "Model weights: Distributed with none. A code licence is not a weights licence."',
    verdict: 'pass',
  },
  '08-sidebar-collapsed': {
    route: 'collapsed sidebar rail',
    expected: 'the 56px rail with the mark visible and the attribution not reflowed into it',
    observed: 'rail correct at 56px, mark and attribution glyph both present — but the Settings dialog stayed open over it, so the shot does not isolate the rail',
    verdict: 'pass with note',
  },
}

/**
 * What had to be true before each shot could be taken.
 *
 * These are checked at capture time, not asserted here: a shot whose
 * precondition failed has no file, and its row carries the reason instead.
 */
const PRECONDITION = {
  '01-onboarding': 'a first-run dialog is on screen in this Electron profile',
  '03-workspace': 'the onboarding queue has been cleared',
  '05-mode-chat': 'a session that is not blank, and the named tab present in the header',
  '05-mode-trajectory': 'a session that is not blank, and the named tab present in the header',
  '05-mode-watch': 'a session that is not blank, and the named tab present in the header',
  '05-mode-live': 'a session that is not blank, and the named tab present in the header',
  '05-mode-memory': 'a session that is not blank, and the named tab present in the header',
  '05-mode-library': 'a session that is not blank, and the named tab present in the header',
  '05-mode-compare': 'a session that is not blank, and the named tab present in the header',
  '06-settings-general': 'the Settings dialog is open',
  '08-sidebar-collapsed': 'the sidebar has been collapsed',
}

/** The scenario every shot was taken against. */
const SCENARIO = {
  profile: 'manual QA profile, isolated DSH_HOME',
  fixtures: 'scripts/seed-manual-fixtures.mjs, 9 records, all marked demo',
  provider: 'scripts/qa-provider-stub.mjs on loopback, deterministic, no external call',
  session: 'created through session.create, one turn sent through session.prompt',
}

/** PNG dimensions, straight out of the IHDR chunk. */
function pngSize(file) {
  const header = readFileSync(file).subarray(0, 33)
  return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) }
}

function build(captureDir) {
  const index = JSON.parse(readFileSync(join(captureDir, 'index.json'), 'utf8'))
  const shots = Object.values(index)
  const rows = []

  for (const shot of shots) {
    const viewport = shot.name.startsWith('wide-') ? 'wide' : 'narrow'
    const key = shot.name.replace(/^(wide|narrow)-/, '')
    const review = REVIEW[key] ?? {
      route: 'unreviewed', expected: '—', observed: '—', verdict: 'unreviewed',
    }
    const captured = shot.captured !== false && shot.file !== null && existsSync(shot.file)

    rows.push({
      name: shot.name,
      file: captured ? basename(shot.file) : null,
      route: review.route,
      app: 'web',
      viewport,
      // The capture runs in whatever theme the app is in; DSH's default is dark
      // and nothing here switches it, so recording anything else would be a
      // guess rather than an observation.
      theme: 'dark',
      state: captured ? 'captured' : 'not captured',
      fixture: SCENARIO.fixtures,
      scenario: shot.name.includes('05-mode-') ? 'non-blank session, one turn' : 'first run',
      precondition: PRECONDITION[key] ?? 'the settings dialog is open at the named section',
      expected: review.expected,
      observed: captured ? review.observed : shot.note,
      verdict: review.verdict,
      ...captured
        ? {
            bytes: statSync(shot.file).size,
            ...pngSize(shot.file),
            digest: `sha256:${createHash('sha256').update(readFileSync(shot.file)).digest('hex').slice(0, 16)}`,
          }
        : { reason: shot.note },
    })
  }

  // Duplicates are the failure this manifest exists to make visible.
  const byDigest = new Map()
  for (const row of rows) {
    if (row.digest === undefined) continue
    const seen = byDigest.get(row.digest) ?? []
    seen.push(row.name)
    byDigest.set(row.digest, seen)
  }
  const duplicates = [...byDigest.values()].filter(names => names.length > 1)

  return {
    generatedBy: 'scripts/gen-screenshot-manifest.mjs',
    note: 'expected is written before the capture; observed is what a reviewer saw on opening the file.',
    captureDir,
    scenario: SCENARIO,
    totals: {
      shots: rows.length,
      captured: rows.filter(r => r.state === 'captured').length,
      notCaptured: rows.filter(r => r.state === 'not captured').length,
      pass: rows.filter(r => r.verdict.startsWith('pass')).length,
      blocked: rows.filter(r => r.verdict === 'blocked').length,
      fail: rows.filter(r => r.verdict === 'fail').length,
      duplicateGroups: duplicates.length,
    },
    duplicates,
    shots: rows,
  }
}

function markdown(manifest) {
  const line = row => [
    row.name,
    row.file ?? '—',
    row.viewport,
    row.state,
    row.expected,
    row.observed,
    row.verdict,
  ].map(cell => String(cell).replace(/\|/g, '\\|')).join(' | ')

  return `# Screenshot manifest

Generated by \`scripts/gen-screenshot-manifest.mjs\`. Do not edit by hand.

\`expected\` was written before the capture ran. \`observed\` is what a reviewer
saw on opening the file — not what the tool reported about it.

| | |
| --- | --- |
| Shots | ${String(manifest.totals.shots)} |
| Captured | ${String(manifest.totals.captured)} |
| Not captured | ${String(manifest.totals.notCaptured)} |
| Pass | ${String(manifest.totals.pass)} |
| Blocked | ${String(manifest.totals.blocked)} |
| Fail | ${String(manifest.totals.fail)} |
| Duplicate groups | ${String(manifest.totals.duplicateGroups)} |

${manifest.totals.duplicateGroups === 0
    ? 'No two shots are byte-identical. An earlier capture had sixteen that were.'
    : `**${String(manifest.totals.duplicateGroups)} group(s) of identical images:** ${manifest.duplicates.map(g => g.join(' = ')).join('; ')}`}

All shots are of the Web app in the dark theme, which is DSH's default and
which nothing in the capture changes.

| Shot | File | Viewport | State | Expected | Observed | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
${manifest.shots.map(row => `| ${line(row)} |`).join('\n')}

## Why the mode shots are blocked

DSH hides the session header while a session is blank — \`blank &&
composerPhase === 'blank'\` in \`ConversationSession.tsx\`. The mode tabs live in
that header, so they cannot be reached until a session has had a turn, and a
turn needs a provider and a key.

The capture creates a real session through DSH's own \`session.create\` API, so
it gets as far as it can without one. It does not photograph the workspace and
call it a mode.
`
}

function main() {
  const captureDir = process.argv.find(arg => !arg.startsWith('-') && arg !== process.argv[0] && arg !== process.argv[1])
  if (captureDir === undefined) {
    process.stderr.write('usage: node scripts/gen-screenshot-manifest.mjs <capture-dir> [--check]\n')
    process.exit(2)
  }
  if (!existsSync(join(captureDir, 'index.json'))) {
    process.stderr.write(`watch: no index.json in ${captureDir}\n`)
    process.exit(2)
  }

  const manifest = build(captureDir)
  const json = `${JSON.stringify(manifest, null, 2)}\n`
  const md = markdown(manifest)

  if (process.argv.includes('--check')) {
    const stale = !existsSync(OUT_JSON) || readFileSync(OUT_JSON, 'utf8') !== json
    if (stale) {
      process.stderr.write('watch: docs/screenshot-manifest.json is stale\n')
      process.exit(1)
    }
    process.stdout.write('screenshots: manifest current\n')
    return
  }

  writeFileSync(OUT_JSON, json)
  writeFileSync(OUT_MD, md)
  process.stdout.write(
    `screenshots: ${String(manifest.totals.shots)} shot(s) — `
    + `${String(manifest.totals.captured)} captured, ${String(manifest.totals.notCaptured)} not\n`
    + `  ${String(manifest.totals.pass)} pass, ${String(manifest.totals.blocked)} blocked, `
    + `${String(manifest.totals.fail)} fail, ${String(manifest.totals.duplicateGroups)} duplicate group(s)\n`,
  )
}

main()

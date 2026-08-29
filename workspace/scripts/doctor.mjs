#!/usr/bin/env node
/**
 * Is this machine able to build and run Watch Workspace?
 *
 * The rule this follows, and the reason it is short: it checks what the
 * repository actually needs, and reports everything else as optional with the
 * capability it belongs to. A doctor that demands ffmpeg, Python, a GPU and a
 * browser runtime before anyone can run `npm run check` teaches people to
 * ignore it, and it would be lying -- none of those are needed to build this,
 * and each belongs to a capability you opt into.
 *
 * Exit code 1 only when something genuinely required is missing or wrong.
 * Optional findings are printed and do not fail.
 *
 * Usage:
 *   node scripts/doctor.mjs
 *   node scripts/doctor.mjs --json
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { nodeSatisfies, nodeBelowTestedFloorOnly } from './lib/node-range.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const JSON_OUT = process.argv.includes('--json')

/** Run a command and return its first line, or null when it is not there. */
function probe(command, args) {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: process.platform === 'win32',
    }).trim().split('\n')[0]
  } catch {
    return null
  }
}

const findings = []
const add = (level, name, detail, fix = null) => {
  findings.push({ level, name, detail, ...fix === null ? {} : { fix } })
}

// ── required ───────────────────────────────────────────────────────────────

const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const declaredNode = manifest.engines?.node ?? ''
const actualNode = process.version
if (declaredNode === '') {
  add('warn', 'node', `${actualNode}, and package.json declares no range`)
} else if (nodeSatisfies(declaredNode, actualNode)) {
  add('ok', 'node', `${actualNode} satisfies ${declaredNode}`)
} else if (nodeBelowTestedFloorOnly(declaredNode, actualNode)) {
  add('warn', 'node', `${actualNode} is below the tested ${declaredNode}`,
    'Everything runs here, but CI does not test this patch level. '
    + 'Upgrade before trusting a failure you cannot reproduce on CI.')
} else {
  add('fail', 'node', `${actualNode} does not satisfy ${declaredNode}`,
    'Install a Node in the declared range. nvm, fnm and volta all work.')
}

const pnpm = probe('pnpm', ['--version'])
const wantPnpm = (manifest.packageManager ?? '').replace('pnpm@', '')
if (pnpm === null) {
  add('fail', 'pnpm', 'not on PATH',
    `Install pnpm ${wantPnpm || '10'}: corepack enable, or npm i -g pnpm`)
} else if (wantPnpm !== '' && pnpm.split('.')[0] !== wantPnpm.split('.')[0]) {
  add('warn', 'pnpm', `${pnpm}, and packageManager pins ${wantPnpm}`,
    'corepack enable will use the pinned version')
} else {
  add('ok', 'pnpm', pnpm)
}

const git = probe('git', ['--version'])
if (git === null) {
  add('fail', 'git', 'not on PATH', 'Install git; the upstream baseline is fetched with it.')
} else {
  add('ok', 'git', git.replace('git version ', ''))
}

// The pinned DSH source. Not vendored, and several gates read it.
const upstream = join(ROOT, 'upstream', 'deepseek-harness')
if (existsSync(join(upstream, 'package.json'))) {
  add('ok', 'upstream baseline', 'checked out')
} else {
  add('fail', 'upstream baseline', 'missing',
    'node scripts/upstream-sync.mjs -- inventory and parity read the pinned DSH source')
}

if (existsSync(join(ROOT, 'node_modules'))) {
  add('ok', 'dependencies', 'installed')
} else {
  add('fail', 'dependencies', 'not installed', 'pnpm install --frozen-lockfile')
}

// ── optional, each named with the capability it belongs to ─────────────────

const optional = [
  ['watch-skill', ['--version'], 'Watch Core',
    'pip install watch-skill. Without it the Bridge runs on its mock backend and every capability reports not_tested.'],
  ['python', ['--version'], 'OCR and ASR engines',
    'Only needed if you enable a local perception engine.'],
  ['ffmpeg', ['-version'], 'video and audio sources',
    'Only needed if you capture from video or audio.'],
]
for (const [command, args, capability, fix] of optional) {
  const version = probe(command, args)
  if (version === null) add('optional', command, `not found -- ${capability} unavailable`, fix)
  else add('ok', command, `${version} (${capability})`)
}

// Electron ships as a dependency of the Desktop app rather than a system tool.
try {
  const { createRequire } = await import('node:module')
  const require = createRequire(join(ROOT, 'apps', 'desktop', 'package.json'))
  require.resolve('electron')
  add('ok', 'electron', 'resolved from apps/desktop')
} catch {
  add('optional', 'electron', 'not installed -- the Desktop app cannot start',
    'pnpm install brings it in; the Web app does not need it.')
}

// ── report ─────────────────────────────────────────────────────────────────

const failed = findings.filter(f => f.level === 'fail')

if (JSON_OUT) {
  process.stdout.write(`${JSON.stringify({ ok: failed.length === 0, findings }, null, 2)}\n`)
} else {
  const mark = { ok: '  ok  ', warn: ' warn ', fail: ' FAIL ', optional: '  --  ' }
  process.stdout.write('watch workspace doctor\n\n')
  for (const finding of findings) {
    process.stdout.write(`${mark[finding.level]} ${finding.name.padEnd(18)} ${finding.detail}\n`)
    if (finding.fix !== undefined) process.stdout.write(`${' '.repeat(27)}${finding.fix}\n`)
  }
  process.stdout.write(
    failed.length === 0
      ? '\nReady. Optional entries above are capabilities you opt into, not missing pieces.\n'
      : `\n${String(failed.length)} required check(s) failed.\n`,
  )
}

process.exit(failed.length === 0 ? 0 : 1)

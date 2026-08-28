#!/usr/bin/env node
/**
 * Shipped code must not assume the machine it was written on.
 *
 * The distinction this gate draws is between code that *ships* — everything
 * under `packages/` and `apps/` — and the local development and QA scripts that
 * never leave this repository. A default of `G:/watch-manual` in a screenshot
 * tool is a convenience; the same string inside a published package is a bug
 * that only appears on somebody else's computer, which is the worst place for a
 * bug to first appear.
 *
 * So shipped code is held to a stricter rule than scripts, and scripts are held
 * to one rule of their own: whatever they default to, it has to be overridable.
 * A hardcoded path nobody can change is not a default.
 *
 * What counts as a violation in shipped code:
 *
 *   - a drive-letter or absolute POSIX path written into the source
 *   - a `.exe` suffix that is not guarded by a platform check
 *   - `taskkill`, `pkill`, `powershell` or `/bin/sh` invoked directly
 *   - a backslash path separator in a literal
 *   - `process.env.HOME` or `USERPROFILE` read without a fallback
 *
 * Usage: node scripts/verify-portability.mjs
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Code that ships. Held to the strict rule. */
const SHIPPED = ['packages', 'apps']

/** Local tooling. Held only to "your default must be overridable". */
const SCRIPTS = ['scripts']

const SKIP = new Set(['node_modules', 'lib', 'dist', 'assets', '.git', 'coverage'])

/**
 * Patterns that are portable in principle and unportable as written.
 *
 * Each names the fix rather than only the sin, because a gate that says
 * "forbidden" without saying "instead" gets worked around.
 */
const RULES = [
  {
    id: 'drive-letter',
    pattern: /['"`][A-Za-z]:[\\/]/,
    says: 'a drive-letter path is written into the source',
    instead: 'take it from configuration, or derive it from `app.getPath` / `os.homedir()`',
  },
  {
    id: 'absolute-posix',
    pattern: /['"`]\/(?:usr|etc|var|opt|home|tmp)\//,
    says: 'an absolute POSIX path is written into the source',
    instead: 'take it from configuration, or use `os.tmpdir()` / `os.homedir()`',
  },
  {
    id: 'bare-exe',
    pattern: /['"`][\w-]+\.exe['"`]/,
    says: 'an `.exe` name is hardcoded',
    instead: "build it from `process.platform === 'win32' ? '.exe' : ''`",
  },
  {
    id: 'kill-by-name',
    pattern: /\b(taskkill|pkill|killall)\b/,
    says: 'a process is killed by name',
    instead: 'terminate the child by its handle — killing by name can hit somebody else’s process',
  },
  {
    id: 'shell-path',
    pattern: /['"`]\/bin\/(sh|bash)['"`]|['"`]powershell(\.exe)?['"`]/,
    says: 'a specific shell is invoked',
    instead: 'spawn the program directly, or let the platform choose the shell',
  },
  {
    id: 'backslash-separator',
    pattern: /['"`][^'"`\n]*\\\\[a-zA-Z][^'"`\n]*['"`]/,
    says: 'a backslash path separator appears in a literal',
    instead: "use `join()` from `node:path`, or `sep` when a literal is unavoidable",
  },
  {
    id: 'home-without-fallback',
    pattern: /process\.env\.(HOME|USERPROFILE)(?!\s*\?\?)/,
    says: 'a home directory is read without a fallback',
    instead: 'use `os.homedir()`, which is defined on every platform',
  },
]

/** A line the rules do not apply to: a comment, or an explicit exemption. */
function exempt(line) {
  const trimmed = line.trim()
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')
    || line.includes('portability-ok')
}

function* sources(dir) {
  if (!existsSync(dir)) return
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) yield* sources(path)
    else if (/\.(ts|tsx|mjs|cjs|js)$/.test(entry) && !entry.endsWith('.d.ts')) yield path
  }
}

function main() {
  const findings = []
  let scanned = 0

  for (const root of SHIPPED) {
    for (const path of sources(join(ROOT, root))) {
      scanned += 1
      const rel = relative(ROOT, path).replace(/\\/g, '/')
      readFileSync(path, 'utf8').split('\n').forEach((line, index) => {
        if (exempt(line)) return
        for (const rule of RULES) {
          if (rule.pattern.test(line)) {
            findings.push(`${rel}:${String(index + 1)}  ${rule.says} — ${rule.instead}`)
          }
        }
      })
    }
  }

  // Scripts may default to this machine, but the default has to be reachable
  // from outside. A constant nobody can override is not a default.
  const unoverridable = []
  for (const root of SCRIPTS) {
    for (const path of sources(join(ROOT, root))) {
      scanned += 1
      const rel = relative(ROOT, path).replace(/\\/g, '/')
      readFileSync(path, 'utf8').split('\n').forEach((line, index) => {
        if (exempt(line)) return
        if (!/^const \w+ = ['"`][A-Za-z]:[\\/]/.test(line.trim())) return
        unoverridable.push(`${rel}:${String(index + 1)}  a machine path with no environment override`)
      })
    }
  }

  const all = [...findings, ...unoverridable]
  if (all.length > 0) {
    process.stderr.write('watch: code that assumes the machine it was written on\n\n')
    for (const finding of all) process.stderr.write(`  ${finding}\n`)
    process.stderr.write(`\nwatch: ${String(all.length)} portability problem(s) across ${String(scanned)} file(s)\n`)
    process.exit(1)
  }

  process.stdout.write(
    `portability: ${String(scanned)} source file(s), no machine-specific assumption in shipped code\n`,
  )
}

main()

#!/usr/bin/env node
/**
 * ADR-002, checked mechanically across the whole workspace.
 *
 * Only Watch Core mints an EvidenceRecord or a Verification Verdict. The unit
 * tests prove that by shape and at runtime; this proves it by exhaustion, which
 * is the part that survives someone adding a file next month. It reads every
 * TypeScript and JavaScript source in `packages`, `apps` and `scripts` and
 * fails if any of them produces a verdict.
 *
 * Two kinds of line are allowed to mention a verdict, and both are narrow:
 *
 *   - reading, rendering, comparing and stripping — `verdict === 'VERIFIED'`,
 *     a label map, an allowlist that rebuilds a submission. These handle a
 *     verdict that already exists; they do not create one.
 *   - the manual-test fixture generator, which is not product code, ships in no
 *     package, and marks every record it writes as demo data.
 *
 * Anything else is a release blocker under §22.4, so this exits non-zero.
 *
 * Usage: node scripts/verify-verdict-authority.mjs
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ROOTS = ['packages', 'apps', 'scripts']
const SKIP = new Set(['node_modules', 'dist', 'lib', '.git', 'coverage'])

/**
 * The fixture generator is the one file permitted to write verdict literals.
 * It is listed here by path rather than by a comment pragma, so adding a second
 * such file is a deliberate edit to this gate and not a copied annotation.
 */
const FIXTURE_GENERATOR = 'scripts/seed-manual-fixtures.mjs'

/** This file names everything it forbids, so it cannot scan itself. */
const SELF = 'scripts/verify-verdict-authority.mjs'

/** An assignment: `verdict: 'VERIFIED'`, `verdict = "FAILED"`. */
const ASSIGNMENT = /\bverdict\s*[:=]\s*['"`](VERIFIED|FAILED|PARTIAL|INCONCLUSIVE)['"`]/

/**
 * Producing an evidence record.
 *
 * The receiver is the whole distinction, and missing it is how this gate first
 * read the SDK as a violation. `CoreGateway.mintEvidence` is *Core's* method —
 * declared, in that file, as the engine side of the host, supplied by Watch and
 * never by a plugin. A capability calling `gateway.mintEvidence(candidate)` is
 * the sanctioned path working exactly as designed: it hands a sanitized
 * candidate across the boundary and takes back whatever Core decides.
 *
 * So a bare call, or one on any receiver other than the gateway, is a
 * violation. A call through the gateway is the architecture.
 */
const MINT = /\b(mintVerdict|mintEvidence|createEvidenceRecord|makeVerified)\s*\(/
const VIA_GATEWAY = /\b(gateway|coreGateway|core|this\.gateway)\??\.(mintVerdict|mintEvidence|createEvidenceRecord|makeVerified)\s*\(/

/** The one interface allowed to declare it: Core describing its own side. */
const GATEWAY_FILE = 'packages/watch/sdk/src/capability.ts'

function* sources(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) yield* sources(path)
    else if (/\.(ts|tsx|mjs|cjs|js|jsx)$/.test(entry)) yield path
  }
}

function main() {
  const findings = []
  let scanned = 0

  for (const root of ROOTS) {
    for (const path of sources(join(ROOT, root))) {
      const rel = relative(ROOT, path).replace(/\\/g, '/')
      if (rel.startsWith('tests/') || rel === SELF) continue
      scanned += 1

      const lines = readFileSync(path, 'utf8').split('\n')
      let inGateway = false

      lines.forEach((line, index) => {
        // Track the CoreGateway block, so a declaration inside it reads as Core
        // describing itself rather than as a plugin acquiring a power.
        if (/^export interface CoreGateway\b/.test(line)) inGateway = true
        else if (inGateway && /^\}/.test(line)) inGateway = false

        const assigns = ASSIGNMENT.test(line)
        const mints = MINT.test(line)
          && !VIA_GATEWAY.test(line)
          && !(inGateway && rel === GATEWAY_FILE)
        if (!assigns && !mints) return

        // The fixture generator is allowed its literals, but not a mint.
        if (rel === FIXTURE_GENERATOR && assigns && !mints) return

        findings.push(`${rel}:${String(index + 1)}  ${line.trim()}`)
      })
    }
  }

  // The permission above is worth exactly as much as the marking it relies on.
  const fixture = readFileSync(join(ROOT, FIXTURE_GENERATOR), 'utf8')
  if (!fixture.includes('demo: true')) {
    findings.push(`${FIXTURE_GENERATOR}: writes verdict literals without marking them as demo data`)
  }

  if (findings.length > 0) {
    process.stderr.write('watch: verdict authority violated — only Watch Core may mint a verdict\n\n')
    for (const finding of findings) process.stderr.write(`  ${finding}\n`)
    process.stderr.write(`\nwatch: ${String(findings.length)} violation(s) across ${String(scanned)} source file(s)\n`)
    process.exit(1)
  }

  process.stdout.write(
    `verdict authority holds — ${String(scanned)} source file(s), `
    + 'no product code assigns a verdict or mints evidence outside Core\n',
  )
}

main()

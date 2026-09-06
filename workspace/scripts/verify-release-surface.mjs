#!/usr/bin/env node
/**
 * What a person reads on their way into this product, held to being true.
 *
 * The failures this exists for were all readable, and none of them was caught
 * by a test: an onboarding screen that said four of twelve capabilities were
 * ready on every machine in the world, an install guide naming a package
 * nobody had published, a screenshot manifest describing a connected engine
 * because the field was a constant in the generator, a command with a
 * maintainer's drive letter in it.
 *
 * The scan is narrow on purpose. Sweeping the whole repository for these words
 * is almost entirely noise — `placeholder` is a DOM attribute, `not
 * implemented` is usually an honest capability disclosure, `temporary` is a
 * directory — and a gate that cries wolf gets an allowlist bolted onto it
 * until it means nothing. So `release-surface-rules.json` lists the surfaces
 * by name, and every exemption is one file and one rule with a reason.
 *
 * The same table is read by `tests/test_release_surface.py`, which covers the
 * two surfaces this cannot reach: the CLI's help output and the built wheel
 * and sdist. One table, so a rule cannot be relaxed on one side only.
 *
 * Usage:
 *   node scripts/verify-release-surface.mjs
 *   node scripts/verify-release-surface.mjs --json
 *   node scripts/verify-release-surface.mjs --artifacts <dir>   also scan tarballs
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const REPO = join(ROOT, '..')
const JSON_OUT = process.argv.includes('--json')
const artifactsFlag = process.argv.indexOf('--artifacts')
const ARTIFACTS = artifactsFlag >= 0
  ? process.argv[artifactsFlag + 1]
  : join(ROOT, '.release-artifacts')

const CONFIG = JSON.parse(readFileSync(join(REPO, 'release-surface-rules.json'), 'utf8'))
const RULES = CONFIG.rules.map(rule => ({ ...rule, re: new RegExp(rule.pattern, 'g') }))

/** A glob with `**` and `*`, anchored, over forward-slash paths. */
function globToRegExp(glob) {
  let out = '^'
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i]
    if (char === '*') {
      if (glob[i + 1] === '*') {
        // `**/` swallows any number of directories, including none.
        if (glob[i + 2] === '/') { out += '(?:[^/]+/)*'; i += 2 } else { out += '.*'; i += 1 }
      } else out += '[^/]*'
    } else if ('\\^$.|?+()[]{}'.includes(char)) out += `\\${char}`
    else out += char
  }
  return new RegExp(`${out}$`)
}

const INCLUDE = CONFIG.surfaces.include.map(globToRegExp)
const EXCLUDE = CONFIG.surfaces.exclude.map(globToRegExp)
const EXEMPT = new Set(CONFIG.exemptions.map(entry => `${entry.file}\u0000${entry.rule}`))

const findings = []

/** Every rule against one blob of text, minus what that file is exempt from. */
function scan(label, text, exemptKey = label) {
  const lines = text.split(/\r?\n/)
  for (const rule of RULES) {
    if (EXEMPT.has(`${exemptKey}\u0000${rule.id}`)) continue
    for (let i = 0; i < lines.length; i += 1) {
      rule.re.lastIndex = 0
      const found = rule.re.exec(lines[i])
      if (found === null) continue
      findings.push({
        file: label,
        line: i + 1,
        rule: rule.id,
        why: rule.why,
        text: lines[i].trim().slice(0, 120),
      })
      break // one finding per rule per file is enough to act on
    }
  }
}

/**
 * What a commit of the current work would carry, not only what git has.
 *
 * `git ls-files` alone reads the last commit's idea of the tree, so a page
 * added in this change is invisible to the gate until after it lands — which
 * is the one moment the gate is worth having. `--others
 * --exclude-standard` adds the untracked files that are not ignored, which is
 * exactly the set a `git add -A` would stage.
 */
function surfaceCandidates() {
  return execFileSync(
    'git', ['ls-files', '--cached', '--others', '--exclude-standard'],
    { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 28 })
    .split('\n').map(line => line.trim()).filter(line => line !== '')
}

/** The documents, manifests and generated evidence a reader is pointed at. */
function scanSurfaces() {
  let scanned = 0
  for (const file of surfaceCandidates()) {
    const path = file.split('\\').join('/')
    if (!INCLUDE.some(re => re.test(path))) continue
    if (EXCLUDE.some(re => re.test(path))) continue
    scan(path, readFileSync(join(REPO, file), 'utf8'))
    scanned += 1
  }
  return scanned
}

/**
 * What npm shows: the description, and nothing else from the manifest.
 *
 * A keyword or a script name is not something a person reads on a package
 * page; the description is the whole of what a registry renders under the
 * name, and it is the field a stale product claim survives in.
 */
function scanPackageDescriptions() {
  let scanned = 0
  for (const parent of ['packages/watch', 'apps']) {
    const at = join(ROOT, parent)
    if (!existsSync(at)) continue
    for (const name of readdirSync(at)) {
      const manifest = join(at, name, 'package.json')
      if (!existsSync(manifest)) continue
      const parsed = JSON.parse(readFileSync(manifest, 'utf8'))
      if (typeof parsed.description !== 'string') continue
      scan(`${relative(REPO, manifest).split('\\').join('/')} (description)`,
        parsed.description, relative(REPO, manifest).split('\\').join('/'))
      scanned += 1
    }
  }
  return scanned
}

/** Every text file inside every tarball a publish would upload. */
function scanTarballs() {
  if (!existsSync(ARTIFACTS)) return { archives: 0, files: 0 }
  const tarballs = readdirSync(ARTIFACTS).filter(name => name.endsWith('.tgz')).sort()
  let files = 0
  for (const tarball of tarballs) {
    const listing = execFileSync('tar', ['-tzf', tarball], {
      cwd: ARTIFACTS, encoding: 'utf8', maxBuffer: 1 << 28,
    }).split('\n').map(line => line.trim()).filter(line => line.endsWith('.md'))
    for (const member of listing) {
      const text = execFileSync('tar', ['-xzOf', tarball, member], {
        cwd: ARTIFACTS, encoding: 'utf8', maxBuffer: 1 << 28,
      })
      scan(`${tarball}:${member.replace(/^package\//, '')}`, text, member.replace(/^package\//, ''))
      files += 1
    }
  }
  return { archives: tarballs.length, files }
}

function main() {
  const documents = scanSurfaces()
  const descriptions = scanPackageDescriptions()
  const tarballs = scanTarballs()

  const result = {
    ok: findings.length === 0,
    scanned: { documents, descriptions, tarballs: tarballs.archives, tarballFiles: tarballs.files },
    findings,
  }

  if (JSON_OUT) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    return result.ok ? 0 : 1
  }

  process.stdout.write(
    `\nrelease surface\n\n  documents     ${String(documents)}\n`
    + `  descriptions  ${String(descriptions)}\n`
    + `  tarballs      ${String(tarballs.archives)} (${String(tarballs.files)} documents)\n`)

  if (findings.length > 0) {
    process.stderr.write('\n')
    for (const finding of findings) {
      process.stderr.write(
        `  ${finding.file}:${String(finding.line)}  [${finding.rule}] ${finding.why}\n`
        + `      ${finding.text}\n`)
    }
    process.stderr.write(
      `\nrelease-surface: ${String(findings.length)} thing(s) a reader should not be shown.\n`
      + 'Fix the text, or add an exact file+rule exemption with a reason to '
      + 'release-surface-rules.json.\n')
    return 1
  }
  process.stdout.write('\nNothing on the release surface is unfinished, stale or personal.\n')
  return 0
}

process.exit(main())

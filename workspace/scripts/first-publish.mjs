#!/usr/bin/env node
/**
 * One-time npm bootstrap for the first @deepwatch publication.
 *
 * This exists because of an ordering npm imposes and nothing here can avoid:
 * a Trusted Publisher is configured *on a package*, and a package that has
 * never been published has no page to configure it on. `release-deepwatch.yml`
 * has no token path at all, deliberately — so the very first version of each
 * of the twenty has to be uploaded by the release owner, from a machine, with
 * an ordinary authenticated npm session. Every publication after that one goes
 * through the workflow, and this script is never run again.
 *
 * Dry-run is the default and never contacts npm. `--check-access` performs the
 * read-only identity and organisation probes. Publishing additionally needs
 * both `--publish` and `--confirm-first-publish`; there is intentionally no
 * environment-variable shortcut.
 *
 * **The registry decision is not made here.** It was, once, and it was made
 * badly: `npm view <name>@<version>` was run, a zero exit meant "already
 * published, skip" and any non-zero exit meant "absent, publish". Both halves
 * are wrong in a way that only shows up on a bad day. A version that exists
 * with *different bytes* was skipped silently, shipping a scope whose halves
 * came from different commits; and a network blip, an expired credential or a
 * registry 503 was read as proof of absence, which is how an outage turns into
 * twenty duplicate uploads. `publish-plan.mjs` already asks the right question
 * — it compares the registry's integrity against the tarball this run would
 * upload, and distinguishes absence from failure by npm's own `E404` — so this
 * script asks it rather than keeping a second, worse opinion.
 *
 * One policy, in one place: **publish what is absent, skip what is
 * demonstrably identical, refuse what conflicts, and stop on anything it
 * cannot tell apart.**
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveNpm } from './lib/process.mjs'
import { buildPlan } from './publish-plan.mjs'
import { publishOrder } from './publish-order.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const EXPECTED_ORDER = Object.freeze([
  '@deepwatch/dsh-client-brand',
  '@deepwatch/dsh-contracts',
  '@deepwatch/dsh-trajectory',
  '@deepwatch/dsh-workspace',
  '@deepwatch/dsh-client-evidence',
  '@deepwatch/dsh-memory',
  '@deepwatch/dsh-client-memory',
  '@deepwatch/dsh-technology',
  '@deepwatch/dsh-library',
  '@deepwatch/dsh-core-bridge',
  '@deepwatch/dsh-tools',
  '@deepwatch/dsh-client-remotes',
  '@deepwatch/dsh-client-settings',
  '@deepwatch/dsh-live',
  '@deepwatch/dsh-bundle',
  '@deepwatch/cli',
  '@deepwatch/dsh-wiki',
  '@deepwatch/dsh-adapters',
  '@deepwatch/dsh-sdk',
  '@deepwatch/dsh-tenancy',
])

function option(name, fallback) {
  const at = process.argv.indexOf(`--${name}`)
  return at < 0 ? fallback : process.argv[at + 1]
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options })
  return {
    code: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

/**
 * npm's own words, with anything secret taken out of them.
 *
 * The previous version captured npm's output and threw it away, then told the
 * operator to "authenticate with a short-lived, 2FA-protected publisher token"
 * — the same sentence for an expired session, a 403 from the wrong account, a
 * proxy refusing CONNECT and a registry that was simply down. Three of those
 * four are not fixed by making a token, and the one message sent the operator
 * to do the one thing that would not help.
 *
 * So npm gets to say what happened. What it must not say is a credential:
 * bearer tokens, npm's own `npm_` tokens, basic-auth headers and `_authToken`
 * lines are replaced before anything reaches a console or a state file.
 *
 * @param text - raw subprocess output.
 * @returns the same text with credential-shaped runs replaced.
 */
export function sanitize(text) {
  return String(text)
    .replace(/\bnpm_[A-Za-z0-9]{16,}/g, 'npm_[redacted]')
    .replace(/(_authToken\s*=\s*)\S+/gi, '$1[redacted]')
    .replace(/(authorization\s*:\s*)(bearer|basic)\s+\S+/gi, '$1$2 [redacted]')
    .replace(/\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[redacted-jwt]')
    .replace(/(:\/\/)[^:@/\s]+:[^@/\s]+@/g, '$1[redacted]@')
    .trim()
}

/** The last few lines of npm's diagnostics, sanitized, for a console. */
function diagnostics(result, lines = 12) {
  const text = sanitize(`${result.stderr}\n${result.stdout}`)
  if (text === '') return '(npm produced no output)'
  return text.split('\n').filter(line => line.trim() !== '').slice(-lines).join('\n')
}

/**
 * The dist-tag a version shape earns, by the same rule the release workflow uses.
 *
 * This was hardcoded to `preview`, which was right while every version was
 * `0.1.0-preview.N` and silently wrong the moment one was not: a stable `0.1.0`
 * published under `preview` leaves `npm i @deepwatch/cli` resolving nothing,
 * because `latest` would not exist. A prerelease must never take `latest`, and a
 * stable release must never take anything else.
 *
 * A prerelease shape this train has no tag for is a refusal rather than a guess
 * — the workflow makes the same call, and the two must not disagree about a
 * publication that cannot be taken back.
 */
export function distTag(version) {
  if (/-preview\./.test(version)) return 'preview'
  if (/-rc\./.test(version)) return 'next'
  if (version.includes('-')) {
    throw new Error(`${version} is a prerelease this train has no dist-tag for`)
  }
  return 'latest'
}

function npm(args) {
  const spec = resolveNpm()
  if (spec === null) {
    return { code: 1, stdout: '', stderr: 'npm is unavailable: nothing named npm is on PATH' }
  }
  return run(spec.command, [...spec.prefix, ...args], { cwd: ROOT })
}

function gitClean() {
  const status = run('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
    cwd: join(ROOT, '..'),
  })
  if (status.code !== 0) throw new Error('git status failed')
  if (status.stdout.trim() !== '') {
    throw new Error('the worktree is dirty; first publication requires an exact committed candidate')
  }
}

function extractPackageJson(tarball) {
  const result = run('tar', ['-xzOf', basename(tarball), 'package/package.json'], {
    cwd: dirname(tarball),
  })
  if (result.code !== 0) throw new Error(`${basename(tarball)} cannot be read as an npm tarball`)
  return JSON.parse(result.stdout)
}

function filesIn(tarball) {
  const result = run('tar', ['-tzf', basename(tarball)], { cwd: dirname(tarball) })
  if (result.code !== 0) throw new Error(`${basename(tarball)} cannot be listed`)
  return result.stdout.split(/\r?\n/)
    .map(file => file.trim().replace(/^package\//, ''))
    .filter(file => file !== '' && !file.endsWith('/'))
    .sort()
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

export function verifyArtifacts(directory) {
  const inventoryPath = join(directory, 'packed-artifacts.json')
  if (!existsSync(inventoryPath)) throw new Error('packed-artifacts.json is absent')
  const inventory = JSON.parse(readFileSync(inventoryPath, 'utf8'))
  if (inventory.counts?.packages !== 20 || inventory.packages?.length !== 20) {
    throw new Error('the inventory does not contain exactly 20 packages')
  }

  const derived = publishOrder().map(entry => entry.name)
  if (!sameJson(derived, EXPECTED_ORDER)) {
    throw new Error('the manifest dependency graph no longer matches the approved first-publish order')
  }

  const records = new Map(inventory.packages.map(record => [record.name, record]))
  const verified = []
  for (const name of EXPECTED_ORDER) {
    const record = records.get(name)
    if (record === undefined) throw new Error(`${name} is absent from the inventory`)
    if (record.access !== 'public') throw new Error(`${name} does not declare public access`)
    const tarball = resolve(directory, record.file)
    if (dirname(tarball) !== resolve(directory)) throw new Error(`${name} names a tarball outside the artifact directory`)
    if (!existsSync(tarball)) throw new Error(`${name} tarball is absent`)
    const sha256 = createHash('sha256').update(readFileSync(tarball)).digest('hex')
    if (sha256 !== record.sha256) throw new Error(`${name} tarball SHA-256 does not match the inventory`)

    const manifest = extractPackageJson(tarball)
    if (manifest.name !== name || manifest.version !== record.version) {
      throw new Error(`${name} tarball identity does not match the inventory`)
    }
    if (!manifest.name.startsWith('@deepwatch/') || manifest.private === true) {
      throw new Error(`${name} is outside the public @deepwatch scope`)
    }
    if (manifest.publishConfig?.access !== 'public') {
      throw new Error(`${name} tarball does not declare publishConfig.access=public`)
    }
    if (!sameJson(filesIn(tarball), [...record.files].sort())) {
      throw new Error(`${name} file list does not match the inventory`)
    }
    for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
      for (const [dependency, range] of Object.entries(manifest[field] ?? {})) {
        if (dependency.startsWith('@deepwatch/') && !records.has(dependency)) {
          throw new Error(`${name} ${field} names ${dependency}, which is outside the inventory`)
        }
        if (String(range).startsWith('workspace:') || String(range).startsWith('file:')) {
          throw new Error(`${name} contains a source fallback for ${dependency}`)
        }
      }
    }
    if (!sameJson(manifest.dependencies ?? {}, record.dependencies ?? {})) {
      throw new Error(`${name} dependency graph does not match the inventory`)
    }
    if (!sameJson(manifest.peerDependencies ?? {}, record.peerDependencies ?? {})) {
      throw new Error(`${name} peer dependency graph does not match the inventory`)
    }
    verified.push({ name, version: manifest.version, file: record.file, sha256 })
  }
  return verified
}

/**
 * Who npm thinks is running this, and what that says about publishing.
 *
 * Two probes, and neither of them is proof of permission. `whoami` proves a
 * credential resolves to an account. `org ls` proves that account's role in
 * the organisation the scope belongs to. What neither can prove is that npm
 * will accept a publish: the scope is empty, so there is no package ACL to
 * read, and a 2FA policy, a token with the wrong type, or an org billing
 * state are all invisible to a read-only probe and all decisive at upload.
 *
 * This used to claim otherwise. `npm access list packages @deepwatch`
 * returning zero was recorded as `access: 'verified'` — and for an empty scope
 * that command succeeds and prints nothing, which is exactly the state where
 * nothing has been verified at all. The honest report says what was actually
 * established and names the first upload as the thing that settles the rest.
 *
 * Nothing here prints a user name, a token or npm configuration.
 */
function checkAccess() {
  const identity = npm(['whoami', '--registry=https://registry.npmjs.org/'])
  if (identity.code !== 0 || identity.stdout.trim() === '') {
    throw new Error(
      'npm has no authenticated identity for registry.npmjs.org.\n'
      + `npm said:\n${diagnostics(identity)}\n\n`
      + 'If this is an expired or absent session, sign in as the release owner:\n'
      + '  npm login --registry=https://registry.npmjs.org/ --auth-type=web\n'
      + 'If it is a network or proxy failure, the message above says so and a new '
      + 'credential will not help.')
  }

  // The scope is an npm organisation, so the account's role in it is the
  // closest read-only thing to a publish right. Reported, not asserted.
  const org = npm(['org', 'ls', 'deepwatch', '--json'])
  let role = 'unknown'
  if (org.code === 0) {
    try {
      const members = JSON.parse(org.stdout)
      const mine = Object.entries(members).find(([member]) => member === identity.stdout.trim())
      role = mine === undefined ? 'not_a_member' : String(mine[1])
    } catch {
      role = 'unreadable'
    }
  } else {
    role = 'unreadable'
  }

  const listing = npm(['access', 'list', 'packages', '@deepwatch', '--json'])
  const scope = listing.code === 0
    ? (listing.stdout.trim() === '' || listing.stdout.trim() === '{}' ? 'empty' : 'populated')
    : 'unreadable'

  if (role === 'not_a_member') {
    throw new Error(
      'the authenticated account is not a member of the `deepwatch` organisation, '
      + 'so it cannot publish into the @deepwatch scope.')
  }

  // Deliberately no user name, no token, no npm configuration: a release
  // artifact records that the checks ran and what they established, not who.
  return {
    identity: 'authenticated',
    organisation: '@deepwatch',
    role,
    scopeListing: scope,
    publishPermission: 'not_provable_before_upload',
    note: 'whoami and org membership are read-only probes. npm settles publish '
      + 'permission at the first upload, and that upload is the first package in '
      + 'the order below.',
  }
}

function initialState(mode, artifacts, access) {
  return {
    schemaVersion: 2,
    mode,
    artifacts: resolve(artifacts),
    access,
    plan: [],
    created: [],
    skipped: [],
    failed: [],
    remaining: [...EXPECTED_ORDER],
  }
}

function saveState(path, state) {
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

/**
 * The registry decision for every package, in publish order.
 *
 * Delegated whole to `publish-plan.mjs` so this path and the workflow's path
 * cannot drift into two policies. A single refusal fails everything before the
 * first upload: an npm version can never be replaced, so a set that disagrees
 * with the registry is a decision for a person and not a thing to work around.
 */
function planRegistry(artifacts) {
  const plan = buildPlan({ artifacts })
  if (!plan.ok) {
    const refusals = plan.entries
      .filter(entry => entry.action === 'refuse')
      .map(entry => `  ${entry.name}: ${entry.reason}`)
      .join('\n')
    throw new Error(
      `the registry plan refuses this set:\n${refusals}\n\n`
      + 'A published version can never be replaced. The recovery is a new version, '
      + 'not a retry. See docs/releasing.md.')
  }
  return plan
}

async function main() {
  const artifacts = resolve(option('artifacts', join(ROOT, '.release-artifacts')))
  const statePath = resolve(option('state', join(artifacts, 'first-publish-state.json')))
  const publishing = process.argv.includes('--publish')
  const confirmed = process.argv.includes('--confirm-first-publish')
  const wantsAccess = process.argv.includes('--check-access') || publishing

  gitClean()
  const verified = verifyArtifacts(artifacts)
  const access = wantsAccess
    ? checkAccess()
    : { identity: 'not_checked', organisation: '@deepwatch', role: 'not_checked' }
  const state = initialState(publishing ? 'publish' : 'dry-run', artifacts, access)
  saveState(statePath, state)

  if (!publishing) {
    process.stdout.write(`first-publish dry-run: verified ${String(verified.length)} public tarballs\n`)
    if (wantsAccess) {
      process.stdout.write(
        `npm identity: ${access.identity}; role in ${access.organisation}: ${access.role}; `
        + `scope listing: ${access.scopeListing}\n`
        + 'Publish permission is settled by npm at the first upload, not by these probes.\n')
    }
    process.stdout.write('No registry write was attempted. Add --check-access for read-only npm access checks.\n')
    return 0
  }
  if (!confirmed) throw new Error('--publish also requires --confirm-first-publish')

  // Asked once, before the first upload, and recorded. Between planning and
  // publishing sits nothing but this loop, so re-asking per package would only
  // add twenty round trips and twenty more chances to misread an outage.
  const plan = planRegistry(artifacts)
  state.plan = plan.entries.map(entry => ({
    name: entry.name, version: entry.version, action: entry.action, reason: entry.reason,
  }))
  saveState(statePath, state)

  const decision = new Map(plan.entries.map(entry => [entry.name, entry]))
  for (const item of verified) {
    const entry = decision.get(item.name)
    if (entry === undefined) {
      throw new Error(`${item.name} has no registry decision; refusing to guess`)
    }
    if (entry.action === 'skip') {
      process.stdout.write(`skip      ${item.name} — ${entry.reason}\n`)
      state.skipped.push({ name: item.name, version: item.version, reason: entry.reason })
      state.remaining.shift()
      saveState(statePath, state)
      continue
    }

    process.stdout.write(`publish   ${item.name}@${item.version}\n`)
    const result = npm([
      'publish', join(artifacts, item.file), '--access', 'public', '--tag', distTag(item.version),
    ])
    if (result.code !== 0) {
      const said = diagnostics(result)
      state.failed.push({
        name: item.name, version: item.version, category: 'publish_failed', npm: said,
      })
      saveState(statePath, state)
      process.stderr.write(`\nnpm refused ${item.name}@${item.version}:\n${said}\n\n`)
      throw new Error(
        `${item.name} failed. ${String(state.created.length)} package(s) reached the registry `
        + `and are recorded in ${statePath}. Re-running re-plans against the registry and `
        + 'resumes at the first package that is not already published from this exact build.')
    }
    state.created.push({ name: item.name, version: item.version })
    state.remaining.shift()
    saveState(statePath, state)
  }

  process.stdout.write(
    `\nfirst-publish: ${String(state.created.length)} published, `
    + `${String(state.skipped.length)} already present with identical bytes\n`)
  process.stdout.write(
    'These uploads carry no registry provenance attestation: they were made from a '
    + 'machine, not from the OIDC-authenticated workflow. Configure a Trusted '
    + 'Publisher for each package now, and every later release will be attested.\n')
  return 0
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exitCode = code }).catch(error => {
    process.stderr.write(`first-publish: ${error.message}\n`)
    process.exitCode = 1
  })
}

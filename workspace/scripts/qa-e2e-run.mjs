#!/usr/bin/env node
/**
 * Run the browser end-to-end pass: reset, serve a provider, drive, account.
 *
 * The harness in `qa-e2e.mjs` runs inside Electron and can see the screen. It
 * cannot see the wire, and the wire is where the failure that started all of
 * this actually happened — a person configured OpenRouter and their first
 * message went to DeepSeek. So this half owns the provider: it starts a
 * loopback stub, hands the harness its address, and afterwards counts what
 * arrived.
 *
 * Counting is the point. A pass that only checked the answer on screen would
 * be satisfied by an implementation that called two providers and rendered the
 * second one.
 *
 *   node scripts/qa-e2e-run.mjs --url http://127.0.0.1:8931 --home <profile>/home
 *
 * `--home` is required and is reset before the run: the add-provider catalogue
 * only offers providers that are not yet configured, so a second pass against
 * a configured profile would report "provider saved" without having saved
 * anything. Resetting is what makes the run repeatable and the report true.
 *
 * Nothing here reaches the internet. The stub binds loopback on a port the
 * operating system picks, and no code path in this file reads a provider
 * credential from the environment.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const WORKSPACE = join(HERE, '..')

const { startOpenRouterStub, STUB_API_KEY } = await import(
  pathToFileURL(join(WORKSPACE, 'scripts', 'lib', 'openrouter-stub.mjs')).href)

/** Read `--name value` pairs, because this has three and no more. */
function option(name, fallback = null) {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? fallback : process.argv[at + 1]
}

const URL = option('url', 'http://127.0.0.1:8931')
const HOME = option('home')
const OUT = option('out', join(WORKSPACE, 'qa', 'e2e'))

if (HOME === null) {
  process.stderr.write('qa-e2e-run: --home <profile>/home is required\n')
  process.exit(2)
}

/**
 * Return the profile to "no provider configured".
 *
 * Two files hold it: the credential store, and the `providers` block in
 * settings. Removing the store and that block is the smallest reset that
 * restores the precondition — rebuilding the whole runtime takes four minutes
 * and proves nothing extra about the provider flow.
 */
function resetProviders(home) {
  const dshHome = join(home, 'dsh-home')
  const credentials = join(dshHome, '.credentials.yaml')
  if (existsSync(credentials)) {
    rmSync(credentials)
    process.stdout.write('reset: removed the credential store\n')
  }

  const settingsPath = join(dshHome, 'settings.yaml')
  if (!existsSync(settingsPath)) return

  // Keep the onboarding block, drop everything else.
  //
  // Deleting the file would be simpler and wrong: `ui-onboarding` carries the
  // profile-scoped suppression of upstream's Internal Testing Notice, and
  // losing it would resurrect a second first-run dialog — which the harness
  // then asserts is absent, so the reset would be quietly breaking the thing
  // it exists to set up.
  //
  // Removing just the `providers:` block was the first attempt and was worse
  // than either: providers are nested under a provider-plugin key, so the
  // surgery left a parent with nothing under it and a settings file the app
  // read differently. Rebuilding from the one block that must survive has no
  // such failure mode.
  const lines = readFileSync(settingsPath, 'utf8').split('\n')
  const kept = []
  let keeping = false
  for (const line of lines) {
    if (/^\S/.test(line)) keeping = /^ui-onboarding:/.test(line)
    if (keeping) kept.push(line)
  }
  writeFileSync(settingsPath, kept.length === 0 ? '' : `${kept.join('\n')}\n`, 'utf8')
  process.stdout.write(
    `reset: settings reduced to ${String(kept.length)} onboarding line(s)\n`)
}

/**
 * The Electron binary the Desktop app already depends on.
 *
 * Found in the pnpm store rather than by `require('electron')`: it is a
 * transitive dependency, so it has no entry in the workspace root's
 * `node_modules` to resolve through.
 */
function electron() {
  const store = join(WORKSPACE, 'node_modules', '.pnpm')
  if (!existsSync(store)) throw new Error('qa-e2e-run: no pnpm store; run pnpm install')
  const pkg = readdirSync(store).find(entry => entry.startsWith('electron@'))
  if (pkg === undefined) throw new Error('qa-e2e-run: electron is not installed')
  const dist = join(store, pkg, 'node_modules', 'electron', 'dist')
  for (const name of ['electron.exe', 'electron']) {
    const candidate = join(dist, name)
    if (existsSync(candidate)) return candidate
  }
  throw new Error(`qa-e2e-run: no electron binary under ${dist}`)
}

async function main() {
  mkdirSync(OUT, { recursive: true })
  resetProviders(HOME)

  const stub = await startOpenRouterStub()
  process.stdout.write(`stub: ${stub.baseURL}\n`)

  let status = 1
  try {
    const run = spawnSync(electron(), [join(WORKSPACE, 'scripts', 'qa-e2e.mjs')], {
      cwd: WORKSPACE,
      encoding: 'utf8',
      timeout: 15 * 60_000,
      env: {
        ...process.env,
        WATCH_E2E_URL: URL,
        WATCH_E2E_OUT: OUT,
        WATCH_E2E_STUB: stub.baseURL,
        WATCH_E2E_STUB_KEY: STUB_API_KEY,
      },
    })
    status = run.status ?? 1
  } finally {
    // What the provider actually saw, whatever the screen said.
    const requests = stub.requests.map(entry => ({
      method: entry.method, url: entry.url, authorized: entry.authorized,
      model: entry.body?.model ?? null,
    }))
    const completions = requests.filter(entry => entry.url.includes('/chat/completions'))
    const accounting = {
      stubUrl: stub.baseURL,
      total: requests.length,
      completions: completions.length,
      catalogueReads: requests.filter(entry => entry.url.includes('/models')).length,
      // The stub is the only server this pass starts, so anything the product
      // sent elsewhere simply is not here. That is why the offline-egress gate
      // exists beside this and is not replaced by it.
      requests,
    }
    writeFileSync(join(OUT, 'stub-accounting.json'),
      `${JSON.stringify(accounting, null, 2)}\n`, 'utf8')
    process.stdout.write(
      `stub saw ${String(requests.length)} request(s): `
      + `${String(accounting.catalogueReads)} catalogue, `
      + `${String(completions.length)} completion(s)\n`)

    // Saving a credential must contact nobody.
    //
    // A product that validated the key on save would look helpful and would be
    // sending a secret to a third party the moment it is typed, before anyone
    // had chosen to use it. This pass configures a provider and sends no
    // prompt, so the honest count is zero — and a number that is only printed
    // is a number nobody checks.
    if (completions.length > 0) {
      process.stderr.write(
        `qa-e2e-run: ${String(completions.length)} completion(s) reached the provider `
        + 'during a pass that sent no prompt\n')
      status = status === 0 ? 1 : status
    }
    await stub.stop()
  }
  process.exit(status)
}

await main()

/**
 * Starting the desktop, in an order where every step can fail visibly.
 *
 * A desktop application that starts two child processes, opens a database and
 * mounts a UI has roughly a dozen ways to be half-started. The failure people
 * report is always the same one: a window that opened and does nothing. So the
 * sequence here is explicit, each step has a name, and the readiness state
 * carries which step it stopped at.
 *
 * Two decisions worth stating.
 *
 * **Migration is checked before anything is opened.** A store written by a
 * newer build is not opened at all — it is reported, and the app offers
 * read-only replay instead. Opening it and hoping is how a downgrade destroys
 * somebody's memory ledger.
 *
 * **The bootstrap secret is generated per launch and never touches a command
 * line.** Arguments are visible to every process on the machine on every
 * platform this ships on. The secret goes in the child's environment, and the
 * Host binds loopback on a port the OS chooses.
 *
 * @module @deepwatch/desktop/startup
 */

import { randomBytes } from 'node:crypto'
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** The steps, in order. */
export type StartupStep =
  | 'single_instance'
  | 'app_data'
  | 'migration_preflight'
  | 'bootstrap_secret'
  | 'dsh_host'
  | 'watch_core'
  | 'bridge_handshake'
  | 'window'
  | 'ready'

/** Every step, in order, for a progress display. */
export const STARTUP_STEPS: readonly StartupStep[] = [
  'single_instance',
  'app_data',
  'migration_preflight',
  'bootstrap_secret',
  'dsh_host',
  'watch_core',
  'bridge_handshake',
  'window',
  'ready',
]

/** How the app ended up running. */
export type LaunchMode =
  /** Everything came up. */
  | 'normal'
  /** Something did not, and the window explains rather than pretending. */
  | 'safe_mode'
  /** The store is newer than this build; nothing is written. */
  | 'read_only_replay'
  /** A second instance handed its arguments to the first and exited. */
  | 'handed_off'

/** Where startup got to. */
export interface Readiness {
  readonly step: StartupStep
  readonly mode: LaunchMode
  readonly detail: string
  readonly fix: string
  /** Steps that completed, in order. */
  readonly completed: readonly StartupStep[]
}

/** The store's schema version, as this build understands it. */
export const STORE_SCHEMA_VERSION = 1

/** What a migration preflight found. */
export interface MigrationCheck {
  readonly found: number | null
  readonly expected: number
  readonly action: 'none' | 'migrate' | 'refuse_newer' | 'initialize'
  readonly detail: string
}

/**
 * Read the store's version without opening it.
 *
 * A one-line marker file rather than a query, so a store this build cannot
 * open does not have to be opened to find that out — which is the entire point
 * of a preflight.
 */
export function migrationPreflight(appDataDir: string): MigrationCheck {
  const marker = join(appDataDir, 'schema-version')
  if (!existsSync(marker)) {
    return {
      found: null,
      expected: STORE_SCHEMA_VERSION,
      action: 'initialize',
      detail: 'No existing store. A new one will be created.',
    }
  }
  const raw = readFileSync(marker, 'utf8').trim()
  const found = Number.parseInt(raw, 10)
  if (!Number.isFinite(found)) {
    return {
      found: null,
      expected: STORE_SCHEMA_VERSION,
      action: 'refuse_newer',
      detail: `The store's version marker is unreadable (${JSON.stringify(raw)}).`,
    }
  }
  if (found > STORE_SCHEMA_VERSION) {
    return {
      found,
      expected: STORE_SCHEMA_VERSION,
      action: 'refuse_newer',
      detail: `The store was written by a newer version of Watch (schema ${String(found)}; `
        + `this build understands ${String(STORE_SCHEMA_VERSION)}).`,
    }
  }
  if (found < STORE_SCHEMA_VERSION) {
    return {
      found,
      expected: STORE_SCHEMA_VERSION,
      action: 'migrate',
      detail: `The store will be migrated from schema ${String(found)} to `
        + `${String(STORE_SCHEMA_VERSION)}.`,
    }
  }
  return { found, expected: STORE_SCHEMA_VERSION, action: 'none', detail: '' }
}

/** Create the application data directory and its subdirectories. */
export function prepareAppData(appDataDir: string): void {
  for (const sub of ['', 'memory', 'artifacts', 'logs', 'updates']) {
    mkdirSync(sub === '' ? appDataDir : join(appDataDir, sub), { recursive: true })
  }
}

/** Stamp the schema version after a successful initialize or migrate. */
export function stampSchemaVersion(appDataDir: string): void {
  writeFileSync(join(appDataDir, 'schema-version'), `${String(STORE_SCHEMA_VERSION)}\n`, 'utf8')
}

/**
 * A per-launch bootstrap secret.
 *
 * Regenerated every start, so a secret that leaks is worthless by the next
 * launch, and never written to disk. The Host receives it in its environment.
 */
export function bootstrapSecret(): string {
  return randomBytes(32).toString('base64url')
}

/**
 * The environment one child receives.
 *
 * A function rather than an object literal at the call site, so there is one
 * place to check that the secret is in `env` and the argv builder below is one
 * place to check that it is not in `argv`.
 */
export function childEnvironment(input: {
  readonly secret: string
  readonly appDataDir: string
  readonly offlineOnly: boolean
}): Readonly<Record<string, string>> {
  return {
    WATCH_BOOTSTRAP_SECRET: input.secret,
    WATCH_APP_DATA: input.appDataDir,
    WATCH_OFFLINE_ONLY: input.offlineOnly ? '1' : '0',
    // Loopback, and port 0 so the OS picks one. A fixed port is a port
    // something else on the machine can already be listening on.
    WATCH_HOST_BIND: '127.0.0.1',
    WATCH_HOST_PORT: '0',
  }
}

/**
 * The arguments one child receives.
 *
 * Deliberately carries nothing sensitive. `assertNoSecretsInArgv` is what keeps
 * that true as the list grows.
 */
export function childArguments(input: { readonly appDataDir: string }): readonly string[] {
  return ['--app-data', input.appDataDir]
}

/**
 * Refuse an argument vector that carries something secret.
 *
 * Called by the launcher and asserted by a test. A command line is readable by
 * every process on the machine, so this is not defence in depth — it is the
 * defence.
 */
export function assertNoSecretsInArgv(
  argv: readonly string[],
  secrets: readonly string[],
): void {
  for (const secret of secrets) {
    if (secret === '') continue
    for (const argument of argv) {
      if (argument.includes(secret)) {
        throw new Error(
          'watch-desktop: a secret reached a command line, where every process on '
          + 'this machine can read it. Pass it in the child environment instead.',
        )
      }
    }
  }
}

/** Readiness after a step completed. */
export function advance(
  readiness: Readiness,
  step: StartupStep,
): Readiness {
  return {
    ...readiness,
    step,
    completed: [...readiness.completed, readiness.step],
  }
}

/** Readiness at the very beginning. */
export function initialReadiness(): Readiness {
  return {
    step: 'single_instance',
    mode: 'normal',
    detail: '',
    fix: '',
    completed: [],
  }
}

/** Stop, with the step that failed and what to do. */
export function halt(
  readiness: Readiness,
  mode: LaunchMode,
  detail: string,
  fix: string,
): Readiness {
  return { ...readiness, mode, detail, fix }
}

/**
 * One line for the window when startup did not complete.
 *
 * Always names the step. "Watch could not start" is not a message anybody can
 * act on; "Watch Core did not start (restart budget spent)" is.
 */
export function describeReadiness(readiness: Readiness): string {
  if (readiness.mode === 'normal' && readiness.step === 'ready') return 'Ready.'
  if (readiness.mode === 'read_only_replay') {
    return `Read-only: ${readiness.detail} ${readiness.fix}`.trim()
  }
  if (readiness.mode === 'safe_mode') {
    return `Safe mode at ${readiness.step}: ${readiness.detail} ${readiness.fix}`.trim()
  }
  return `Starting — ${readiness.step}`
}

/**
 * Whether a launch may write anything.
 *
 * Read-only replay is not advisory. Everything that writes asks this first, so
 * a store from a newer build cannot be modified by an older one on any path,
 * including the paths nobody thought about.
 */
export function mayWrite(readiness: Readiness): boolean {
  return readiness.mode !== 'read_only_replay'
}

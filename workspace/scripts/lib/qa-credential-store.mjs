/**
 * Which credential document a QA run is allowed to touch.
 *
 * A QA pass resets the provider state it is about to configure — that is what
 * makes it repeatable. Resetting is only safe while "the store" means the one
 * inside the throwaway room. It stopped meaning that once rooms learned to
 * reference an existing credentials document by path: `dsh-credentials-local`
 * takes the document's location as configuration, so a profile pointed at a
 * person's real document makes every write in the run land there. It is not a
 * hypothetical. A QA pass configured a provider through the UI and the save
 * added an `OPENROUTER_E2E_API_KEY` entry to the owner's document, beside the
 * key they actually use.
 *
 * The reset was never the dangerous part on its own; the dangerous part was
 * that nothing in the harness knew *which document it had been aimed at*. So
 * this module answers that question before anything runs, and the answer is
 * fail-closed: a QA run proceeds only against a store inside its own room.
 *
 * Two passes decide it, and both must agree:
 *
 *  1. a structured read of each profile's loader patch for the credentials
 *     entry's `path` / `dshHome` config, mirroring `resolveSpec` upstream
 *     (an explicit `path` wins, else `dshHome` + the document name, else
 *     `$DSH_HOME`, else the room's own harness home); and
 *  2. a blunt textual sweep for *any* credential-document-shaped location in
 *     those files.
 *
 * The second pass exists because the first is a scanner, not a YAML parser,
 * and a scanner that silently fails to see an override would hand back exactly
 * the reassuring answer this module was written to stop giving. Anything the
 * structured read did not account for is treated as an override it missed.
 *
 * Nothing here opens a credentials document or reads a value out of one. The
 * question is only ever *where*.
 *
 * @module scripts/lib/qa-credential-store
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

/** The document name `dsh-credentials-local` uses under a harness home. */
export const CREDENTIALS_FILENAME = '.credentials.yaml'

/** Loader-patch ids that configure the local credential provider. */
const CREDENTIAL_IDS = new Set(['credentials', 'credentials-local', 'dsh-credentials-local'])

/**
 * Is `candidate` inside `root`?
 *
 * Compared through `relative` rather than by string prefix: `D:/room` and
 * `D:/room-2` share a prefix and share nothing else, and that is precisely the
 * near-miss a containment check has to get right.
 *
 * @param root - the directory that must contain it.
 * @param candidate - an absolute path.
 * @returns true when `candidate` is `root` or below it.
 */
export function isInside(root, candidate) {
  const step = relative(resolve(root), resolve(candidate))
  if (step === '') return true
  return !step.startsWith('..') && !step.startsWith(`..${sep}`) && !/^[A-Za-z]:/.test(step)
}

/**
 * The harness home and the room that contains it, from whichever one was given.
 *
 * `--home` means two different things across this repository's gates.
 * `qa-e2e-run.mjs` takes the room directory that *holds* `dsh-home`;
 * `verify-agent-profile.mjs` takes the harness home itself, and joins
 * `profiles/` onto it. Both are reasonable and neither is going to be
 * renamed for this, so the shape is detected rather than assumed — a guard
 * that silently resolved the wrong directory would report containment it had
 * not checked, which is worse than not having the guard.
 *
 * @param home - a room directory or a harness home.
 * @returns `{ room, dshHome }`, both absolute.
 */
export function locate(home) {
  const given = resolve(home)
  const nested = join(given, 'dsh-home')
  if (existsSync(nested)) return { room: given, dshHome: nested }
  if (existsSync(join(given, 'profiles'))) return { room: dirname(given), dshHome: given }
  // Neither exists yet — a room being built. The documented layout wins.
  return { room: given, dshHome: nested }
}

/** Every profile directory under a room's harness home, in listing order. */
function profileDirectories(dshHome) {
  const profiles = join(dshHome, 'profiles')
  if (!existsSync(profiles)) return []
  return readdirSync(profiles)
    .map(name => join(profiles, name))
    .filter(path => statSync(path).isDirectory())
}

/** The loader files a profile composes its tree from, those that exist. */
function profileConfigFiles(profileDir) {
  return ['cordis.yml', 'cordis.patch.yml', 'cordis.patch.yaml']
    .map(name => join(profileDir, name))
    .filter(path => existsSync(path))
}

/**
 * The credentials entry's `path` / `dshHome`, read out of one loader file.
 *
 * Scanned line by line because the workspace's scripts carry no YAML parser
 * and a QA guard is the wrong place to acquire a dependency. The shape being
 * read is the one `deepwatch setup` and the room builders write: a top-level
 * array of `- id: <name>` entries, each with an indented `config:` block.
 *
 * @param text - the file's contents.
 * @returns the keys found under a credentials entry, possibly empty.
 */
function scanCredentialConfig(text) {
  const found = []
  const lines = text.split(/\r?\n/)
  let inEntry = false
  let inConfig = false
  for (const line of lines) {
    const entry = /^\s*-\s+id:\s*['"]?([\w-]+)['"]?\s*$/.exec(line)
    if (entry !== null) {
      inEntry = CREDENTIAL_IDS.has(entry[1])
      inConfig = false
      continue
    }
    // Any other top-level list item, or a new top-level key, ends the entry.
    if (/^\s*-\s/.test(line) || /^\S/.test(line)) {
      if (!/^\s*#/.test(line)) { inEntry = false; inConfig = false }
      continue
    }
    if (!inEntry) continue
    if (/^\s*config:\s*$/.test(line)) { inConfig = true; continue }
    if (!inConfig) continue
    const pair = /^\s*(path|dshHome):\s*['"]?([^'"#]+?)['"]?\s*$/.exec(line)
    if (pair !== null) found.push({ key: pair[1], value: pair[2] })
  }
  return found
}

/**
 * Every credential-document-shaped location named anywhere in a loader file.
 *
 * Deliberately indiscriminate. This is the half that does not trust the
 * scanner: it matches a quoted or bare value for any `path`/`dshHome` key and
 * any literal reference to the document name, wherever it appears and whatever
 * structure it appears in. False positives here cost an explicit `--credentials`
 * flag; a false negative costs somebody their credential store.
 *
 * @param text - the file's contents.
 * @returns absolute-ish location strings, unresolved.
 */
function sweepCredentialLocations(text) {
  const hits = []
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue
    const keyed = /^\s*(?:-\s+)?(?:path|dshHome):\s*['"]?([^'"#]+?)['"]?\s*$/.exec(line)
    if (keyed !== null) hits.push(keyed[1])
    if (line.includes(CREDENTIALS_FILENAME)) {
      const quoted = /['"]([^'"]*\.credentials\.yaml)['"]/.exec(line)
      if (quoted !== null) hits.push(quoted[1])
      else {
        const bare = /(\S*\.credentials\.yaml)/.exec(line)
        if (bare !== null) hits.push(bare[1])
      }
    }
  }
  return hits
}

/**
 * Where this room's credential writes will land, and everything they could.
 *
 * `home` is the room's `--home` directory: the one that holds `dsh-home`. The
 * default answer is that room's own document; every other answer comes from a
 * profile that asked for one.
 *
 * @param options - `home`, and `env` for the `DSH_HOME` fallback.
 * @returns the effective store, the room default, and every referenced location.
 */
export function resolveCredentialStores({ home, env = process.env }) {
  const { room, dshHome } = locate(home)
  const roomStore = join(dshHome, CREDENTIALS_FILENAME)

  const references = []
  const add = (value, source) => {
    const text = String(value).trim()
    if (text === '') return
    const filename = text.endsWith(CREDENTIALS_FILENAME)
      ? resolve(text)
      : resolve(join(text, CREDENTIALS_FILENAME))
    references.push({ filename, source, declared: text })
  }

  for (const profileDir of profileDirectories(dshHome)) {
    for (const file of profileConfigFiles(profileDir)) {
      const text = readFileSync(file, 'utf8')
      const where = relative(room, file).split(sep).join('/')
      for (const { key, value } of scanCredentialConfig(text)) {
        add(value, `${where} (credentials.config.${key})`)
      }
      for (const value of sweepCredentialLocations(text)) {
        add(value, `${where} (referenced location)`)
      }
    }
  }

  // `$DSH_HOME` ranks below an explicit config and above the room default,
  // exactly as `resolveDshHome` orders them upstream. It is a reference like
  // any other here: a QA run inheriting a person's shell has inherited theirs.
  if (typeof env.DSH_HOME === 'string' && env.DSH_HOME.trim() !== '') {
    add(env.DSH_HOME, 'environment (DSH_HOME)')
  }

  const seen = new Set()
  const unique = references.filter(entry => {
    const key = entry.filename.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  const effective = unique.find(entry => !isInside(room, entry.filename))?.filename ?? roomStore
  return { room, roomStore, effective, references: unique }
}

/**
 * Refuse a QA run aimed at a store it does not own.
 *
 * Thrown rather than warned. A warning on a run that then resets somebody's
 * credential document is a record of the damage, not a defence against it.
 *
 * @param options - `home`, and `env` for the `DSH_HOME` fallback.
 * @returns the room's own store, which is the only store QA may touch.
 * @throws when any profile or the environment points outside the room.
 */
export function assertTaskOwnedStore({ home, env = process.env }) {
  const resolved = resolveCredentialStores({ home, env })
  const foreign = resolved.references.filter(entry => !isInside(resolved.room, entry.filename))
  if (foreign.length > 0) {
    const named = foreign
      .map(entry => `  ${entry.filename}\n    from ${entry.source}`)
      .join('\n')
    throw new Error(
      'qa-credential-store: this room references a credential document outside itself,\n'
      + `and a QA run resets the store it is aimed at. Refusing to run.\n\n${named}\n\n`
      + `The room is ${resolved.room}\n`
      + `and the only store QA may touch is ${resolved.roomStore}.\n\n`
      + 'A real provider belongs in an owner journey, which is a separate run against a\n'
      + 'room built with an explicit credential reference. Synthetic QA gets a synthetic\n'
      + 'store: remove the reference from the profile, or point it inside the room.')
  }
  return { store: resolved.roomStore, references: resolved.references }
}

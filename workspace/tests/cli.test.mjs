/**
 * The `deepwatch` command line.
 *
 * The rule this holds is the one that makes a CLI worth trusting: it may only
 * offer what is actually implemented, and it may only claim what it measured.
 * A subcommand that prints a plan, or a doctor that reports "ready" for
 * something it never called, is the product lying in the one program whose
 * whole job is to describe this machine honestly.
 *
 * Everything here runs the built binary as a child process, because argv
 * parsing, exit codes and stream handling are the parts a unit test reaches
 * past. The two commands with side effects — `setup` and `web` — are exercised
 * only on their refusal paths, which is where the destructive mistakes live.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BIN = join(ROOT, 'packages', 'watch', 'cli', 'lib', 'bin.js')
const MANIFEST = JSON.parse(
  readFileSync(join(ROOT, 'packages', 'watch', 'cli', 'package.json'), 'utf8'))

/** Run the CLI, and hand back everything it did. */
function deepwatch(args, env = {}) {
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
      timeout: 120_000,
    })
    return { code: 0, stdout, stderr: '' }
  } catch (cause) {
    return {
      code: cause.status ?? 1,
      stdout: String(cause.stdout ?? ''),
      stderr: String(cause.stderr ?? ''),
    }
  }
}

/** A DEEPWATCH_HOME of this test's own, so nothing touches a real install. */
function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'dwcli-'))
  return { dir, dispose: () => { rmSync(dir, { recursive: true, force: true }) } }
}

describe('what the CLI says about itself', () => {
  test('--version is the version the package publishes', () => {
    const ran = deepwatch(['--version'])
    assert.equal(ran.code, 0)
    assert.equal(ran.stdout.trim(), MANIFEST.version,
      'a version command that disagrees with the package is worse than none')
  })

  test('--help lists only commands that exist', () => {
    const ran = deepwatch(['--help'])
    assert.equal(ran.code, 0)
    for (const command of ['doctor', 'setup', 'web', 'desktop']) {
      assert.match(ran.stdout, new RegExp(`deepwatch ${command}\\b`))
    }
    // The attribution and the disclosure travel with the product, including here.
    assert.match(ran.stdout, /built on DeepSeek Harness and powered by Watch Skill/)
    assert.match(ran.stdout, /not affiliated with or endorsed by DeepSeek/)
  })

  test('an unknown command is refused with the usage and a distinct code', () => {
    const ran = deepwatch(['frobnicate'])
    assert.equal(ran.code, 2, 'a usage error is not the same exit code as a failure')
    assert.match(ran.stderr, /is not a command/)
  })

  test('a bare invocation guides rather than crashing or changing anything', () => {
    const box = sandbox()
    try {
      const ran = deepwatch([], { DEEPWATCH_HOME: box.dir })
      assert.match(ran.stdout, /DeepWatch/)
      assert.match(ran.stdout, /what this machine can do/)
      assert.match(ran.stdout, /deepwatch --help/)
    } finally {
      box.dispose()
    }
  })
})

describe('doctor reports what it measured', () => {
  test('every finding carries a state, a detail and a fix where there is one', () => {
    const box = sandbox()
    try {
      const ran = deepwatch(['doctor', '--json'], { DEEPWATCH_HOME: box.dir })
      const report = JSON.parse(ran.stdout)
      assert.equal(typeof report.ok, 'boolean')
      assert.ok(report.findings.length >= 4)
      for (const finding of report.findings) {
        assert.ok(['missing', 'installed', 'reachable', 'unknown'].includes(finding.state),
          `${finding.name} has state ${finding.state}`)
        assert.equal(typeof finding.detail, 'string')
        assert.notEqual(finding.detail, '')
        if (finding.state === 'missing') {
          assert.notEqual(finding.fix, '',
            `${finding.name} is missing and offers no way to fix it`)
        }
      }
    } finally {
      box.dispose()
    }
  })

  test('the Harness is the declared peer, at the version this was built against', () => {
    // Read from inside the workspace, where the optional peer *is* installed —
    // so what this asserts is that doctor reports the thing it actually found,
    // named as a peer, rather than a guess or a directory listing. The other
    // half, a machine with no Harness at all, cannot be observed from in here:
    // `tests/harness-provisioning.test.mjs` runs that in a clean room.
    const box = sandbox()
    try {
      const report = JSON.parse(deepwatch(['doctor', '--json'], { DEEPWATCH_HOME: box.dir }).stdout)
      const harness = report.findings.find(finding => finding.name === 'DeepSeek Harness')
      assert.equal(harness.state, 'reachable', 'the optional peer is installed in this workspace')
      assert.match(harness.detail, /peer/)
      assert.ok(harness.detail.includes(MANIFEST.peerDependencies['@deepseek-ai/dsh']),
        'doctor reported a version other than the one the manifest pins')
      assert.equal(harness.fix, '', 'nothing is wrong, so nothing needs fixing')
    } finally {
      box.dispose()
    }
  })

  test('an override is used, and reported as an override', () => {
    const box = sandbox()
    try {
      const report = JSON.parse(deepwatch(['doctor', '--json'], {
        DEEPWATCH_HOME: box.dir,
        DEEPWATCH_DSH_BIN: process.execPath,
      }).stdout)
      const harness = report.findings.find(finding => finding.name === 'DeepSeek Harness')
      assert.equal(harness.state, 'reachable', 'node answers --version, so it is reachable')
      assert.match(harness.detail, /override/)
    } finally {
      box.dispose()
    }
  })

  test('a profile that does not exist is missing, not merely unknown', () => {
    const box = sandbox()
    try {
      const report = JSON.parse(deepwatch(['doctor', '--json'], { DEEPWATCH_HOME: box.dir }).stdout)
      const profile = report.findings.find(finding => finding.name === 'DeepWatch profile')
      assert.equal(profile.state, 'missing')
      assert.match(profile.fix, /deepwatch setup/)
      assert.equal(report.ok, false, 'DeepWatch cannot start without a profile')
    } finally {
      box.dispose()
    }
  })

  test('Watch Skill missing is not fatal, and says what it costs', () => {
    const box = sandbox()
    try {
      const report = JSON.parse(deepwatch(['doctor', '--json'], {
        DEEPWATCH_HOME: box.dir,
        WATCH_CORE_BIN: join(box.dir, 'no-such-binary'),
      }).stdout)
      const core = report.findings.find(finding => finding.name === 'Watch Skill')
      assert.equal(core.required, false, 'DeepWatch runs without the engine, degraded')
      assert.equal(core.state, 'missing')
      assert.match(core.fix, /pip install watch-skill/)
    } finally {
      box.dispose()
    }
  })

  test('nothing in a doctor run reaches a provider', () => {
    // The report is the evidence: no finding may name a host, a key or a URL.
    const box = sandbox()
    try {
      const raw = deepwatch(['doctor', '--json'], { DEEPWATCH_HOME: box.dir }).stdout
      assert.doesNotMatch(raw, /https?:\/\//, 'a doctor that names an endpoint invites a call')
      assert.doesNotMatch(raw, /api[_-]?key|token|secret/i)
    } finally {
      box.dispose()
    }
  })
})

describe('the commands with side effects refuse before they do harm', () => {
  test('setup will not touch a profile it did not compose', () => {
    const box = sandbox()
    try {
      const profile = join(box.dir, 'dsh-home', 'profiles', 'deepwatch')
      mkdirSync(profile, { recursive: true })
      // Somebody else's profile: no DeepWatch dependency, no DeepWatch bundle.
      const foreign = { name: 'dsh-profile-mine', private: true, dependencies: { left: '1.0.0' } }
      writeFileSync(join(profile, 'package.json'), JSON.stringify(foreign))

      const ran = deepwatch(['setup'], { DEEPWATCH_HOME: box.dir })
      assert.equal(ran.code, 2)
      assert.match(ran.stderr, /was not composed by DeepWatch/)
      assert.match(ran.stderr, /Nothing has been changed/)
      assert.deepEqual(
        JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8')), foreign,
        'the refusal must leave the profile byte-identical')
    } finally {
      box.dispose()
    }
  })

  test('web refuses to start a profile that was never composed', () => {
    const box = sandbox()
    try {
      const ran = deepwatch(['web'], { DEEPWATCH_HOME: box.dir })
      assert.equal(ran.code, 2)
      assert.match(ran.stderr, /no profile named "deepwatch"/)
      assert.match(ran.stderr, /deepwatch setup/)
    } finally {
      box.dispose()
    }
  })

  test('--profile selects a different one, and is reported in the refusal', () => {
    const box = sandbox()
    try {
      const ran = deepwatch(['web', '--profile', 'second'], { DEEPWATCH_HOME: box.dir })
      assert.match(ran.stderr, /no profile named "second"/)
    } finally {
      box.dispose()
    }
  })

  test('desktop admits there is no application rather than sending somebody to find one', () => {
    // It used to say the app arrives "from a platform installer" and to install
    // it "from the project releases". No release has ever carried a desktop
    // asset, `@deepwatch/desktop` is private, and the electron-builder block in
    // its manifest names a builder that is not a dependency and that no script
    // runs -- so that sentence sent a person looking for a file nobody makes.
    const box = sandbox()
    try {
      const ran = deepwatch(['desktop'], { DEEPWATCH_HOME: box.dir })
      assert.equal(ran.code, 2)
      assert.match(ran.stderr, /does not distribute a desktop application/)
      assert.match(ran.stderr, /deepwatch web/, 'it names the thing that does work now')
      assert.doesNotMatch(ran.stderr, /from the project releases/,
        'there is no release asset to send anybody to')
    } finally {
      box.dispose()
    }
  })
})

describe('the package is shaped for publication', () => {
  test('it declares the metadata a public package needs', () => {
    for (const field of ['name', 'version', 'description', 'license', 'repository',
      'homepage', 'bugs', 'engines', 'files', 'exports']) {
      assert.ok(MANIFEST[field] !== undefined, `@deepwatch/cli declares no ${field}`)
    }
    assert.equal(MANIFEST.name, '@deepwatch/cli')
    assert.equal(MANIFEST.publishConfig?.access, 'public')
    assert.deepEqual(MANIFEST.bin, { deepwatch: './lib/bin.js' })
  })

  test('it depends on no private workspace package', () => {
    const packages = join(ROOT, 'packages', 'watch')
    for (const name of Object.keys(MANIFEST.dependencies ?? {})) {
      if (!name.startsWith('@deepwatch/')) continue
      const dir = name.replace('@deepwatch/dsh-', '').replace('@deepwatch/', '')
      const manifestPath = join(packages, dir, 'package.json')
      let manifest
      try {
        manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      } catch {
        continue
      }
      assert.notEqual(manifest.private, true,
        `${name} is private and cannot be a dependency of a published package`)
    }
  })

  test('the Harness it installs is the one this distribution was measured against', () => {
    const lock = readFileSync(join(ROOT, 'upstream', 'deepseek-harness.lock'), 'utf8')
    const pinned = /^version:\s*(.+)$/m.exec(lock)?.[1]?.trim()
    const source = readFileSync(
      join(ROOT, 'packages', 'watch', 'cli', 'src', 'version.ts'), 'utf8')
    const declared = /HARNESS_VERSION = '([^']+)'/.exec(source)?.[1]

    assert.equal(declared, pinned,
      'setup would install a Harness that parity was never measured against')
    assert.equal(MANIFEST.dependencies?.['@deepseek-ai/dsh'], undefined,
      'the Harness must not enter this package’s published dependency closure — '
      + 'its transitive tree carries licences this distribution has not reviewed')
  })
})

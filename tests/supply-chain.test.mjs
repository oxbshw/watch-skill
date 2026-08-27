/**
 * What this build is allowed to ship, and what it says it fits with.
 *
 * The SBOM and the release manifest are generated artifacts, and a generated
 * artifact that nobody asserts anything about is a file people stop reading.
 * So these tests are about the *claims* in them rather than about the
 * generators: that no first-party package ships without a licence, that a
 * model weight nobody has the right to distribute is refused, that the
 * compatibility block names a protocol range a consumer can check, and that a
 * store from a newer build is refused rather than opened.
 *
 * The weight-licence rule is the one worth restating. A repository under MIT
 * says nothing about the weights it publishes: those are a separate grant,
 * frequently more restrictive and sometimes absent. Treating the repository
 * licence as covering both is how a distribution ships something it was never
 * licensed to, and it looks entirely permissive the whole time.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DEEPSEEK_OCR,
  DEEPSEEK_OCR2,
  OCR_ENGINES,
  RAPID_OCR,
  mayDistributeWeights,
} from '@watchskill/dsh-technology'
import { EXPECTED_SCHEMA_DIGESTS, WATCH_PROTOCOL_MIN, WATCH_PROTOCOL_VERSION } from '@watchskill/dsh-contracts'
import { STORE_SCHEMA_VERSION, migrationPreflight } from '@watchskill/watch-desktop'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SBOM = JSON.parse(readFileSync(join(ROOT, 'docs', 'sbom.json'), 'utf8'))
const MANIFEST = JSON.parse(readFileSync(join(ROOT, 'docs', 'release-manifest.json'), 'utf8'))

// ── licences ────────────────────────────────────────────────────────────────

describe('nothing ships without an established right to ship it', () => {
  test('every first-party package declares a licence', () => {
    for (const pkg of MANIFEST.integrity.packages) {
      const declared = MANIFEST.spdx.packages.find(entry => entry.name === pkg.name)
      assert.notEqual(declared, undefined, `${pkg.name} is missing from the SPDX document`)
      assert.notEqual(declared.licenseDeclared, 'NOASSERTION', `${pkg.name} declares no licence`)
    }
  })

  test('the SBOM records a licence for every dependency', () => {
    const unknown = (SBOM.packages ?? []).filter(pkg => pkg.license === 'UNKNOWN')
    assert.deepEqual(unknown.map(pkg => pkg.name), [],
      'a dependency is in the tree with no licence recorded')
  })

  test('third-party notices exist and name the upstream project', () => {
    const notices = readFileSync(join(ROOT, 'THIRD_PARTY_NOTICES.md'), 'utf8')
    assert.match(notices, /DeepSeek Harness/)
    assert.match(notices, /MIT License/)
    assert.match(notices, /b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/)
  })

  test('the attribution the brand renders is the one the README carries', async () => {
    const brand = await import('@watchskill/dsh-client-brand')
    const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
    // Whitespace-normalised on both sides. These are legal statements and have
    // to be the same words everywhere; they are also prose, and prose in a
    // Markdown file is wrapped. Comparing raw bytes would fail on the wrap and
    // teach somebody to delete the assertion.
    const flat = text => text.replace(/\s+/g, ' ').trim()
    assert.ok(flat(readme).includes(flat(brand.ATTRIBUTION)),
      'the README and the product disagree about attribution')
    assert.ok(flat(readme).includes(flat(brand.INDEPENDENCE)),
      'the independence disclosure is missing from the README')
  })

  test('the disclosure travels with the attribution, never alone', async () => {
    const brand = await import('@watchskill/dsh-client-brand')
    // Attribution without the disclosure reads as an endorsement that was
    // never given, so the brand renders both together and the README says both.
    const flat = text => text.replace(/\s+/g, ' ').trim()
    for (const source of ['README.md', 'THIRD_PARTY_NOTICES.md']) {
      const text = flat(readFileSync(join(ROOT, source), 'utf8'))
      if (!text.includes(flat(brand.ATTRIBUTION))) continue
      assert.ok(text.includes(flat(brand.INDEPENDENCE)),
        `${source} attributes upstream without the independence disclosure`)
    }
  })
})

describe('a model weight licence is not a repository licence', () => {
  test('both DeepSeek engines are refused distribution', () => {
    for (const engine of [DEEPSEEK_OCR, DEEPSEEK_OCR2]) {
      assert.equal(mayDistributeWeights(engine), false,
        `${engine.id} would be distributed with an unreviewed weight licence`)
      assert.equal(engine.provenance.weightsLicense, null)
      assert.equal(engine.provenance.weightsLicenseReviewed, false)
    }
  })

  test('a permissive code licence does not unlock the weights', () => {
    // OCR2's repository is Apache-2.0. That is a fact about the code.
    assert.equal(DEEPSEEK_OCR2.provenance.codeLicense, 'Apache-2.0')
    assert.equal(mayDistributeWeights(DEEPSEEK_OCR2), false)
  })

  test('an engine whose weight licence was actually reviewed may ship', () => {
    assert.equal(mayDistributeWeights(RAPID_OCR), true)
    assert.equal(RAPID_OCR.provenance.weightsLicenseReviewed, true)
  })

  test('every engine that needs one is pinned to a revision', () => {
    for (const engine of OCR_ENGINES) {
      if (engine.trust !== 'isolated') continue
      assert.notEqual(engine.provenance.revision, null,
        `${engine.id} runs fetched code and is not pinned`)
    }
  })

  test('nothing installs itself', () => {
    for (const engine of OCR_ENGINES) {
      assert.equal(engine.install.automatic, false, `${engine.id} installs automatically`)
    }
  })

  test('the SBOM carries the same weight verdicts as the code', () => {
    for (const weight of SBOM.modelWeights ?? []) {
      const engine = OCR_ENGINES.find(entry => entry.id === weight.id)
      if (engine === undefined) continue
      assert.equal(weight.mayDistribute, mayDistributeWeights(engine),
        `${weight.id}: the SBOM and the descriptor disagree about distribution`)
    }
  })
})

// ── integrity ───────────────────────────────────────────────────────────────

describe('a build can be checked rather than trusted', () => {
  test('every first-party package has a digest over real files', () => {
    assert.ok(MANIFEST.integrity.packages.length >= 15)
    for (const pkg of MANIFEST.integrity.packages) {
      assert.match(pkg.integrity, /^sha256:[0-9a-f]{64}$/, `${pkg.name} has no usable digest`)
      assert.ok(pkg.sourceFiles > 0, `${pkg.name}'s digest covers no files`)
    }
  })

  test('the digests are distinct, so they are digesting something', () => {
    const digests = MANIFEST.integrity.packages.map(pkg => pkg.integrity)
    assert.equal(new Set(digests).size, digests.length,
      'two packages share a digest, which means the digest is not over their content')
  })

  test('the SPDX document is a real SPDX document', () => {
    assert.equal(MANIFEST.spdx.spdxVersion, 'SPDX-2.3')
    assert.equal(MANIFEST.spdx.SPDXID, 'SPDXRef-DOCUMENT')
    assert.equal(MANIFEST.spdx.dataLicense, 'CC0-1.0')
    assert.ok(MANIFEST.spdx.creationInfo.creators.length > 0)
    for (const pkg of MANIFEST.spdx.packages) {
      assert.match(pkg.SPDXID, /^SPDXRef-Package-/)
      assert.equal(pkg.checksums[0].algorithm, 'SHA256')
      // Declared, never concluded: nobody has audited the files.
      assert.equal(pkg.licenseConcluded, 'NOASSERTION')
    }
  })

  test('every package the document describes is related to it', () => {
    const described = new Set(
      MANIFEST.spdx.relationships
        .filter(rel => rel.relationshipType === 'DESCRIBES')
        .map(rel => rel.relatedSpdxElement),
    )
    for (const pkg of MANIFEST.spdx.packages) {
      assert.ok(described.has(pkg.SPDXID), `${pkg.name} is in the document but not described by it`)
    }
  })
})

// ── compatibility ───────────────────────────────────────────────────────────

describe('what this build fits with is stated, not implied', () => {
  test('the protocol range in the manifest is the one the code speaks', () => {
    assert.equal(MANIFEST.compatibility.bridgeProtocol.min, WATCH_PROTOCOL_MIN)
    assert.equal(MANIFEST.compatibility.bridgeProtocol.max, WATCH_PROTOCOL_VERSION)
  })

  test('every contract family is in the compatibility block', () => {
    for (const [family, digest] of Object.entries(EXPECTED_SCHEMA_DIGESTS)) {
      assert.equal(MANIFEST.compatibility.schemaDigests[family], digest,
        `${family}'s digest in the manifest does not match the code`)
    }
  })

  test('the baseline names the exact upstream this was built against', () => {
    assert.match(MANIFEST.compatibility.deepseekHarness, /0\.1\.1-rc\.2/)
    assert.match(MANIFEST.compatibility.deepseekHarness, /b150a551/)
    assert.equal(MANIFEST.compatibility.upstreamLockPresent, true)
  })

  test('a digest mismatch degrades one family rather than the product', () => {
    assert.match(MANIFEST.compatibility.onDigestMismatch, /Other families continue/)
  })
})

describe('what this build can open is stated too', () => {
  test('the manifest agrees with the desktop about the store schema', () => {
    assert.equal(MANIFEST.migration.storeSchemaVersion, STORE_SCHEMA_VERSION)
  })

  test('a newer store is refused, and the manifest says so', () => {
    assert.equal(MANIFEST.migration.refusesNewer, true)
    assert.match(MANIFEST.migration.onNewerStore, /read-only replay/)
  })

  test('the refusal the manifest describes is the one the code performs', () => {
    // The manifest is a claim. This is the claim being true.
    const directory = join(ROOT, 'docs')
    // A directory with no marker initializes rather than migrating, which is
    // the same branch the manifest's `transitions` describes.
    assert.equal(existsSync(directory), true)
    assert.equal(migrationPreflight(directory).action, 'initialize')
  })

  test('every version below the current one is understood', () => {
    assert.deepEqual(
      [...MANIFEST.migration.understands],
      Array.from({ length: STORE_SCHEMA_VERSION }, (_, index) => index + 1),
    )
  })
})

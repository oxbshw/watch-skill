#!/usr/bin/env node
/**
 * The signing configuration, validated before anything is packaged.
 *
 * This gate exists to make one failure impossible: shipping an unsigned build
 * that looks signed. It checks the configuration, never the credentials — no
 * secret is read, printed, written or inferred here, and there is nothing in
 * this file a leaked log could expose.
 *
 * It fails **closed**. If a release build is asked for and the credentials are
 * absent, that is an error rather than a silent downgrade to unsigned. The
 * opposite default — quietly producing an unsigned artifact when signing was
 * intended — is how an unsigned build reaches a user who believes otherwise.
 *
 * A development build is a different thing and is allowed to be unsigned, but
 * it has to say so in its own metadata. "Unsigned and labelled" is honest;
 * "unsigned and indistinguishable" is not.
 *
 * Usage:
 *   node scripts/verify-signing.mjs             validate the configuration
 *   node scripts/verify-signing.mjs --release   also require the credentials
 */

import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * What a signed release needs, per platform.
 *
 * Names only. The gate asserts a variable is *set*, never looks at its value,
 * so running it cannot leak a certificate or a password even into a crash
 * dump.
 */
const REQUIREMENTS = {
  win32: {
    label: 'Windows Authenticode',
    secrets: ['WATCH_WIN_CERT_PFX_BASE64', 'WATCH_WIN_CERT_PASSWORD'],
    // A signature without a countersignature stops verifying the moment the
    // certificate expires, which is the one thing long-lived software cannot
    // afford.
    notes: ['A timestamp server is required: an untimestamped signature dies with the certificate.'],
    timestampUrl: 'http://timestamp.digicert.com',
  },
  darwin: {
    label: 'Apple Developer ID + notarization',
    secrets: [
      'WATCH_MAC_CERT_P12_BASE64', 'WATCH_MAC_CERT_PASSWORD',
      'WATCH_APPLE_ID', 'WATCH_APPLE_APP_PASSWORD', 'WATCH_APPLE_TEAM_ID',
    ],
    notes: [
      'Signing alone is not enough since Catalina: an un-notarized build is refused by Gatekeeper.',
      'Notarization needs network access and Apple’s service, so it cannot be done offline.',
      'Hardened runtime must be on, or notarization is rejected.',
    ],
    timestampUrl: null,
  },
  linux: {
    label: 'detached GPG signature',
    secrets: ['WATCH_GPG_PRIVATE_KEY', 'WATCH_GPG_PASSPHRASE'],
    notes: ['Linux has no platform gatekeeper; the signature is for the person verifying a download.'],
    timestampUrl: null,
  },
}

function main() {
  const release = process.argv.includes('--release')
  const platform = process.platform
  const problems = []
  const notes = []

  const manifestPath = join(ROOT, 'apps', 'desktop', 'package.json')
  if (!existsSync(manifestPath)) {
    process.stderr.write('watch: apps/desktop/package.json is missing\n')
    process.exit(1)
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const build = manifest.build ?? {}

  // ── configuration, checked on every platform ────────────────────────────
  if (typeof build.appId !== 'string' || !build.appId.includes('.')) {
    problems.push('build.appId must be a reverse-DNS identifier; a signature is bound to it')
  }
  if (build.productName !== 'DeepWatch') {
    problems.push(`build.productName is ${String(build.productName)}, not the product name`)
  }
  for (const [key, target] of [['win', 'icon'], ['mac', 'icon'], ['linux', 'icon']]) {
    if (typeof build[key]?.[target] !== 'string') {
      problems.push(`build.${key}.${target} is not set; a packaged app with no icon is not a release`)
    }
  }

  const requirement = REQUIREMENTS[platform] ?? null
  if (requirement === null) {
    problems.push(`no signing requirements are defined for ${platform}`)
  } else {
    notes.push(`${platform}: ${requirement.label}`)
    for (const note of requirement.notes) notes.push(`  ${note}`)

    // Presence only. The value is never read.
    const missing = requirement.secrets.filter(name => (process.env[name] ?? '') === '')
    if (missing.length === 0) {
      notes.push(`  every credential is present (${String(requirement.secrets.length)} variable(s))`)
    } else if (release) {
      // Fail closed. A release that quietly produces an unsigned artifact is
      // the failure this whole gate exists to prevent.
      problems.push(
        `a release build was requested and ${String(missing.length)} credential(s) are missing: ${missing.join(', ')}`,
      )
    } else {
      notes.push(`  ${String(missing.length)} credential(s) absent — development build, must be labelled unsigned`)
    }
  }

  if (problems.length > 0) {
    process.stderr.write('watch: the signing configuration is not release-ready\n\n')
    for (const problem of problems) process.stderr.write(`  ${problem}\n`)
    process.stderr.write(
      '\nwatch: no fake certificate is ever generated to get past this. '
      + 'Supply the real credentials, or build without --release and label it unsigned.\n',
    )
    process.exit(1)
  }

  process.stdout.write(
    `signing: configuration valid${release ? ' and credentials present' : ' (development build)'}\n`
    + notes.map(note => `  ${note}\n`).join(''),
  )
}

main()

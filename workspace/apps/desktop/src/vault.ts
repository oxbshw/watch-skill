/**
 * At-rest protection for Local Personal memory.
 *
 * The claim this module has to earn is narrow and testable: with encrypted
 * mode active, the content of a sensitive memory cannot be read out of the
 * place it is normally stored. Not "we set a flag". Not "the database supports
 * encryption". The bytes on disk, opened by something that is not this
 * application, must not contain the sentence.
 *
 * That is what {@link sealRecord} and the test around it establish, and the
 * distinction matters because "encrypted at rest" is the most commonly
 * overclaimed sentence in desktop software.
 *
 * The key is not in the file. It lives in whatever the platform offers —
 * Electron's `safeStorage`, which is DPAPI on Windows, the Keychain on macOS,
 * and libsecret where it is present. That dependency is injected rather than
 * imported, so this module is testable without Electron and so a platform
 * where no such store exists is a platform that says so instead of quietly
 * writing the key next to the data.
 *
 * @module @deepwatch/desktop/vault
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHash,
} from 'node:crypto'

/**
 * A place to keep a key that is not the disk beside the data.
 *
 * Two methods, matching what every OS credential store offers. `available()`
 * is separate from the operations so a platform without one can be reported
 * rather than discovered at the first write.
 */
export interface KeyStore {
  readonly id: string
  available(): boolean
  /** Encrypt a key for storage. Throws when unavailable. */
  protect(plaintext: Buffer): Buffer
  /** Decrypt one back. Throws when unavailable. */
  unprotect(sealed: Buffer): Buffer
  /** Whether the protection is enforced by the operating system. */
  readonly osBacked: boolean
}

/**
 * Electron's `safeStorage`, adapted.
 *
 * Injected as a parameter so this file does not import Electron and so the
 * adapter can be exercised against a stand-in. The real thing is DPAPI,
 * Keychain or libsecret depending on the platform.
 */
export function safeStorageKeyStore(safeStorage: {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
}): KeyStore {
  return {
    id: 'os.safe-storage',
    osBacked: true,
    available: () => safeStorage.isEncryptionAvailable(),
    protect: plaintext => safeStorage.encryptString(plaintext.toString('base64')),
    unprotect: sealed => Buffer.from(safeStorage.decryptString(sealed), 'base64'),
  }
}

/**
 * The fallback when the platform offers nothing.
 *
 * It exists so the application still runs, and it is labelled `osBacked:
 * false` so nothing built on top of it may describe itself as OS-protected.
 * {@link vaultAssurance} is what turns that flag into the sentence a person
 * reads, and it does not soften it.
 */
export function passthroughKeyStore(): KeyStore {
  return {
    id: 'fallback.passthrough',
    osBacked: false,
    available: () => true,
    protect: plaintext => plaintext,
    unprotect: sealed => sealed,
  }
}

/** How a record is stored. */
export interface SealedRecord {
  readonly memoryId: string
  /** AES-256-GCM, base64. */
  readonly ciphertext: string
  readonly iv: string
  readonly authTag: string
  /** Which key sealed it, so a rotation can find what it has to re-seal. */
  readonly keyId: string
  /** Algorithm, spelled out so a stored record is self-describing. */
  readonly algorithm: 'aes-256-gcm'
}

/** A vault key, and where it came from. */
export interface VaultKey {
  readonly keyId: string
  readonly key: Buffer
  readonly store: KeyStore
}

/** Mint a new vault key and seal it with the platform's key store. */
export function createVaultKey(store: KeyStore): {
  readonly key: VaultKey
  readonly sealedKey: Buffer
} {
  const material = randomBytes(32)
  const keyId = createHash('sha256').update(material).digest('hex').slice(0, 16)
  return {
    key: { keyId, key: material, store },
    sealedKey: store.protect(material),
  }
}

/** Recover a vault key the platform sealed. */
export function openVaultKey(store: KeyStore, sealedKey: Buffer): VaultKey {
  const material = store.unprotect(sealedKey)
  const keyId = createHash('sha256').update(material).digest('hex').slice(0, 16)
  return { keyId, key: material, store }
}

/**
 * Seal one record's content.
 *
 * GCM rather than CBC: an authenticated mode means a record somebody edited on
 * disk fails to open rather than opening as something else, and "something
 * else" in a memory ledger is a statement the system now believes.
 */
export function sealRecord(key: VaultKey, memoryId: string, content: string): SealedRecord {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key.key, iv)
  // The id is authenticated but not encrypted: a sealed record has to be
  // findable, and binding the id into the tag means a record cannot be moved
  // onto another id without the open failing.
  cipher.setAAD(Buffer.from(memoryId, 'utf8'))
  const ciphertext = Buffer.concat([cipher.update(content, 'utf8'), cipher.final()])
  return {
    memoryId,
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    keyId: key.keyId,
    algorithm: 'aes-256-gcm',
  }
}

/** Open a sealed record, or throw. */
export function openRecord(key: VaultKey, sealed: SealedRecord): string {
  const decipher = createDecipheriv(
    'aes-256-gcm',
    key.key,
    Buffer.from(sealed.iv, 'base64'),
  )
  decipher.setAAD(Buffer.from(sealed.memoryId, 'utf8'))
  decipher.setAuthTag(Buffer.from(sealed.authTag, 'base64'))
  return Buffer.concat([
    decipher.update(Buffer.from(sealed.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8')
}

/** What may honestly be said about a vault's protection. */
export interface VaultAssurance {
  readonly encrypted: boolean
  readonly osBacked: boolean
  /** The sentence shown in Settings. Never softened. */
  readonly statement: string
  /** Platforms this has actually been observed on. */
  readonly provenOn: readonly string[]
}

/**
 * Describe the protection truthfully.
 *
 * The `osBacked: false` sentence is deliberately blunt. A fallback that
 * described itself as "encrypted" would be technically true — the content is
 * encrypted — and materially misleading, because the key is sitting next to
 * the data and anything that can read one can read the other.
 */
export function vaultAssurance(
  store: KeyStore,
  observedPlatforms: readonly string[] = [],
): VaultAssurance {
  if (!store.osBacked) {
    return {
      encrypted: true,
      osBacked: false,
      statement:
        'Memory is encrypted on disk, but this platform offers no credential store, '
        + 'so the key is kept beside it. Anything that can read the database can read '
        + 'the key. This is not equivalent to operating-system protection.',
      provenOn: observedPlatforms,
    }
  }
  return {
    encrypted: true,
    osBacked: true,
    statement:
      'Memory is encrypted on disk with a key held by the operating system’s '
      + 'credential store. The key is never written beside the data.',
    provenOn: observedPlatforms,
  }
}

/**
 * Whether a record's content has to be sealed before it is written.
 *
 * Everything sensitive, always. Everything else in Local Personal mode too:
 * deciding per record which memories are worth protecting is a decision that
 * gets made wrong once and then is wrong forever, because nobody re-audits a
 * classification after the fact.
 */
export function mustSeal(
  mode: string,
  record: { readonly sensitivity: string },
): boolean {
  if (record.sensitivity === 'sensitive' || record.sensitivity === 'restricted') return true
  return mode === 'local_personal'
}

/**
 * Search a buffer for a plaintext needle.
 *
 * Exists for the test that matters — reading the stored bytes and asserting
 * the sentence is not in them — and for a diagnostic that can run the same
 * check on a real store when somebody doubts the claim.
 */
export function containsPlaintext(stored: Buffer | string, needle: string): boolean {
  const haystack = typeof stored === 'string' ? stored : stored.toString('binary')
  if (needle === '') return false
  if (haystack.includes(needle)) return true
  // A UTF-16 store would hide a UTF-8 search. Checked explicitly rather than
  // assumed away, because "we looked and did not find it" is only worth
  // something if the looking was thorough.
  return haystack.includes(Buffer.from(needle, 'utf16le').toString('binary'))
}

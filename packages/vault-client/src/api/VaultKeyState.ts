import { decryptWithKey, type CryptoResult } from './crypto'
import { importKeyring, Keyring, VaultNotInitializedError } from './Keyring'

/** This realm's keys and session. The sync worker keeps its own `Keyring`, loaded from `exportKeyringData`. */
class VaultKeyState {
  readonly keyring = new Keyring()
  /** The password-derived key that wraps the keyring, which is set whenever the keyring has keys */
  private masterKey: CryptoKey | null = null
  /** Whether the master key came from PBKDF2. On those accounts it is also data key v1 (see `initialiseVault`). */
  masterKeyIsLegacy = false
  keyHash = ''
  session = ''
  activeAccount = ''
  /** Bumped whenever the keys are forgotten, so a request that finishes after locking can't restore a session */
  private generation = 0

  get currentGeneration(): number {
    return this.generation
  }

  /** Whether the keys haven't been forgotten since `generation` was read */
  isCurrent(generation: number): boolean {
    return generation === this.generation
  }

  requireMasterKey(): CryptoKey {
    if (!this.masterKey) {
      throw new VaultNotInitializedError()
    }
    return this.masterKey
  }

  /** Sets the master key, and on PBKDF2 accounts its role as data key v1 */
  setMasterKey(key: CryptoKey, isLegacy: boolean) {
    this.masterKey = key
    this.masterKeyIsLegacy = isLegacy
    if (isLegacy) {
      this.keyring.replace(new Map([['1', key]]), '1')
    } else {
      this.keyring.clear()
    }
  }

  /** Replaces the master key that wraps the keyring, keeping every data key */
  rewrapMasterKey(key: CryptoKey) {
    this.masterKey = key
    this.masterKeyIsLegacy = false
  }

  /** Merges the keys of a keyring wrapped with the master key into this one */
  async loadEncryptedKeyring(encryptedKeyringStr: string): Promise<void> {
    const encryptedKeyring = JSON.parse(encryptedKeyringStr) as CryptoResult
    const plaintext = await decryptWithKey(this.requireMasterKey(), encryptedKeyring)
    const keyringData = JSON.parse(plaintext)
    if (keyringData && typeof keyringData === 'object' && keyringData.activeVersion) {
      const { keys, activeVersion } = await importKeyring(keyringData)
      this.keyring.merge(keys, activeVersion)
    }
  }

  /** Forgets every key and the session */
  clear() {
    this.generation += 1
    this.keyring.clear()
    this.masterKey = null
    this.masterKeyIsLegacy = false
    this.keyHash = ''
    this.session = ''
    this.activeAccount = ''
  }
}

export const vaultKeys = new VaultKeyState()

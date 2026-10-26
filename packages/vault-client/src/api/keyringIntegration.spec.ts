import {
  initialiseVault,
  loginVault,
  storeVault,
  rotateVaultKey,
  exportKeyringData,
  hasVaultKey,
  reloadKeyringFromStorage,
  clearVaultDeviceData,
} from './vault'
import { getVaultSession, handleSessionExpired, lockVaultKeys, onLateSession } from './session'
import { readCachedKeyring } from './keyringCache'
import { readStoredMetadata } from './storedMetadata'
import { configureVaultHost } from './vaultHost'
import { Keyring } from './Keyring'
import { vaultKeys } from './VaultKeyState'
import { getSessionExpiredHandler } from './runtime'
import { getVaultStorageNames } from '../sync/shared/storageNames'
import { deleteStoredSessionToken } from '../sync/shared/workerAuthStore'
import { deriveLegacyKey } from '../../test/deriveLegacyKey'

import { updateKeyring, getKeyring, getSession } from './AccountClient'
import * as accountClientModule from './AccountClient'
import * as workerAuthStoreModule from '../sync/shared/workerAuthStore'
import { spyOnExports } from '../../test/moduleMocks'

const SALT = 'c2FsdDEyMw=='

const { keyring } = vaultKeys

beforeEach(() => {
  spyOnExports(accountClientModule, {
    getSession: vi.fn().mockResolvedValue('mock-session'),
    createAccount: vi.fn(),
    getSecurityParams: vi.fn(),
    getKeyring: vi.fn().mockResolvedValue({ randomDataKeys: false }),
    updateKeyring: vi.fn().mockResolvedValue(undefined),
    changePassword: vi.fn().mockResolvedValue(undefined),
  })
  spyOnExports(workerAuthStoreModule, {
    deleteStoredSessionToken: vi.fn().mockResolvedValue(undefined),
  })
})

describe('Vault Keyring Integration', () => {
  beforeEach(async () => {
    localStorage.clear()
    configureVaultHost({ deriveLegacyKey })
    await clearVaultDeviceData()
    vi.clearAllMocks()
  })

  it('initializes vault and saves only account to localStorage, exporting keyring separately', async () => {
    const hash = await initialiseVault({
      password: 'password123',
      salt: SALT,
      saltVersion: 1,
      iterations: 1000,
    })
    expect(hash).toBeDefined()
    expect(hasVaultKey('1')).toBe(true)

    await storeVault('test-account')

    const stored = localStorage.getItem(getVaultStorageNames().vaultMetadataKey)
    expect(stored).toBeDefined()

    const parsed = JSON.parse(stored!)
    expect(parsed.account).toBe('test-account')
    expect(parsed.key).toBeUndefined()
    expect(parsed.authToken).toBeUndefined()

    // Test exportKeyringData
    const exported = await exportKeyringData()
    const keyData = JSON.parse(exported)
    expect(keyData.activeVersion).toBe('1')
    expect(keyData['1']).toBeDefined()
  })

  it('restores only the account from localStorage, without loading keys', async () => {
    await initialiseVault({
      password: 'password123',
      salt: SALT,
      saltVersion: 1,
      iterations: 1000,
    })
    await storeVault('test-account')

    // Clear memory keyring
    await clearVaultDeviceData()

    // Restore account only
    localStorage.setItem(getVaultStorageNames().vaultMetadataKey, JSON.stringify({ account: 'test-account' }))

    expect(readStoredMetadata()?.account).toBe('test-account')

    // keyring should be empty
    expect(hasVaultKey('1')).toBe(false)
  })

  it('loads worker vault using exported keyring', async () => {
    await initialiseVault({
      password: 'password123',
      salt: SALT,
      saltVersion: 1,
      iterations: 1000,
    })

    const exported = await exportKeyringData()

    const workerKeyring = new Keyring()
    await workerKeyring.load(exported)

    expect(workerKeyring.getKey('1')).toBeDefined()
    expect(workerKeyring.getKey()).toBeDefined()
    const encrypted = await keyring.encrypt('hello worker')
    await expect(workerKeyring.decrypt(encrypted)).resolves.toBe('hello worker')
  })

  it('automatically tags encrypted string with kver and decrypts correctly', async () => {
    await initialiseVault({
      password: 'password123',
      salt: SALT,
      saltVersion: 1,
      iterations: 1000,
    })

    const enc = await keyring.encrypt('hello keyring')
    expect(enc.kver).toBe('1')

    const dec = await keyring.decrypt(enc)
    expect(dec).toBe('hello keyring')
  })

  it('gracefully falls back to version 1 when decrypting legacy data lacking kver', async () => {
    await initialiseVault({
      password: 'password123',
      salt: SALT,
      saltVersion: 1,
      iterations: 1000,
    })

    const enc = await keyring.encrypt('legacy data')
    // Strip kver to simulate legacy unversioned data
    delete enc.kver

    const dec = await keyring.decrypt(enc)
    expect(dec).toBe('legacy data')
  })

  it('rotates vault key, updates activeKeyVersion, and encrypts/decrypts with new active key version', async () => {
    await loginVault({
      account: 'test-account',
      password: 'password123',
      salt: SALT,
      saltVersion: 1,
      iterations: 1000,
    })

    const enc1 = await keyring.encrypt('data 1')
    expect(enc1.kver).toBe('1')

    await rotateVaultKey('test-account')

    const enc2 = await keyring.encrypt('data 2')
    expect(enc2.kver).toBe('2')

    // Both should decrypt correctly
    expect(await keyring.decrypt(enc1)).toBe('data 1')
    expect(await keyring.decrypt(enc2)).toBe('data 2')
  })

  it('refuses to rotate without a session, so the new key cannot stay on this device only', async () => {
    await initialiseVault({
      password: 'password123',
      salt: SALT,
      saltVersion: 1,
      iterations: 1000,
    })
    await storeVault('test-account')
    const cachedBefore = readCachedKeyring()

    await expect(rotateVaultKey('test-account')).rejects.toThrow('Key rotation needs a connection to the server')

    expect(hasVaultKey('2')).toBe(false)
    expect((await keyring.encrypt('still on version 1')).kver).toBe('1')
    expect(readCachedKeyring()).toBe(cachedBefore)
    expect(updateKeyring).not.toHaveBeenCalled()
  })

  it('rolls back local keyring and activeKeyVersion when keyring upload fails during rotation', async () => {
    await loginVault({
      account: 'test-account',
      password: 'password123',
      salt: SALT,
      saltVersion: 1,
      iterations: 1000,
    })

    expect(hasVaultKey('1')).toBe(true)
    expect(hasVaultKey('2')).toBe(false)

    const cachedBefore = readCachedKeyring()
    expect(cachedBefore).not.toBeNull()

    vi.mocked(updateKeyring).mockRejectedValueOnce(new Error('Network offline'))

    await expect(rotateVaultKey('test-account')).rejects.toThrow(
      'Key rotation failed: keyring upload unsuccessful. Local state rolled back. Cause: Network offline'
    )

    // Keyring must be rolled back to version 1
    expect(hasVaultKey('1')).toBe(true)
    expect(hasVaultKey('2')).toBe(false)

    // Keyring data activeVersion must be rolled back to 1
    const exported = await exportKeyringData()
    const parsed = JSON.parse(exported)
    expect(parsed.activeVersion).toBe('1')
    expect(parsed['2']).toBeUndefined()

    // Subsequent encryption should still use key version 1
    const enc = await keyring.encrypt('still on version 1')
    expect(enc.kver).toBe('1')

    // LocalStorage cached keyring must NOT have been updated with the uncommitted key
    expect(readCachedKeyring()).toBe(cachedBefore)
  })

  it('does not encrypt with uncommitted key during rotation network call, and activates only after upload succeeds', async () => {
    await loginVault({
      account: 'test-account',
      password: 'password123',
      salt: SALT,
      saltVersion: 1,
      iterations: 1000,
    })

    expect(hasVaultKey('1')).toBe(true)
    expect(hasVaultKey('2')).toBe(false)

    let concurrentEncryptionKver: string | undefined
    let hasKey2DuringUpload: boolean | undefined

    vi.mocked(updateKeyring).mockImplementationOnce(async () => {
      // Simulate concurrent encryption while the keyring is being uploaded to the server
      const midFlightEnc = await keyring.encrypt('encrypted during upload')
      concurrentEncryptionKver = midFlightEnc.kver
      hasKey2DuringUpload = hasVaultKey('2')
    })

    await rotateVaultKey('test-account')

    // During network call: key 2 was in keyring for decryption, but activeKeyVersion was still 1
    expect(hasKey2DuringUpload).toBe(true)
    expect(concurrentEncryptionKver).toBe('1')

    // After rotation completes: activeKeyVersion is 2
    const postRotationEnc = await keyring.encrypt('encrypted after rotation')
    expect(postRotationEnc.kver).toBe('2')
  })

  it('locks vault keys without clearing stored metadata and clears active session token', async () => {
    await initialiseVault({
      password: 'password123',
      salt: SALT,
      saltVersion: 1,
      iterations: 1000,
    })
    await storeVault('test-account')

    await lockVaultKeys()

    // keyring should be cleared
    expect(hasVaultKey('1')).toBe(false)

    // stored metadata should still exist
    const stored = localStorage.getItem(getVaultStorageNames().vaultMetadataKey)
    expect(stored).toBeDefined()
    expect(JSON.parse(stored!).account).toBe('test-account')

    // and a session token an earlier build stored is deleted
    expect(deleteStoredSessionToken).toHaveBeenCalled()
  })

  it('removes the session expired handler when locking', async () => {
    await loginVault({
      account: 'test-account',
      password: 'password123',
      salt: SALT,
      saltVersion: 1,
      iterations: 1000,
    })
    expect(getSessionExpiredHandler()).not.toBeNull()

    await lockVaultKeys()

    expect(getSessionExpiredHandler()).toBeNull()
  })

  it('handleSessionExpired silently re-establishes session when account and keyHash are available', async () => {
    await loginVault({
      account: 'test-account',
      password: 'password123',
      salt: SALT,
      saltVersion: 1,
      iterations: 1000,
    })

    vi.mocked(getSession).mockClear()
    vi.mocked(getSession).mockResolvedValueOnce('new-mock-session')

    await handleSessionExpired()

    expect(getSession).toHaveBeenCalledWith('test-account', expect.any(String))
    expect(hasVaultKey('1')).toBe(true)
  })

  it('handleSessionExpired reports a lost session without locking vault when silent re-establishment fails', async () => {
    const onSessionLost = vi.fn()
    configureVaultHost({ onSessionLost, deriveLegacyKey })
    await loginVault({
      account: 'test-account',
      password: 'password123',
      salt: SALT,
      saltVersion: 1,
      iterations: 1000,
    })

    vi.mocked(getSession).mockRejectedValueOnce(new Error('Session rejected'))

    await handleSessionExpired()

    // keyring should NOT be cleared - local operations continue
    expect(hasVaultKey('1')).toBe(true)

    // the host is told so it can pause sync and warn the user
    expect(onSessionLost).toHaveBeenCalledWith(expect.stringContaining('Sync paused'))

    // stored metadata MUST NOT be wiped
    const stored = localStorage.getItem(getVaultStorageNames().vaultMetadataKey)
    expect(stored).toBeDefined()
    expect(JSON.parse(stored!).account).toBe('test-account')

    configureVaultHost({ deriveLegacyKey })
  })

  it('handleSessionExpired makes one attempt for concurrent calls', async () => {
    await loginVault({
      account: 'test-account',
      password: 'password123',
      salt: SALT,
      saltVersion: 1,
      iterations: 1000,
    })

    vi.mocked(getSession).mockClear()
    vi.mocked(getSession).mockImplementation(
      () => new Promise(resolve => setTimeout(() => resolve('new-session'), 20))
    )

    const p1 = handleSessionExpired()
    const p2 = handleSessionExpired()
    const p3 = handleSessionExpired()

    await Promise.all([p1, p2, p3])
    expect(getSession).toHaveBeenCalledTimes(1)
  })

  it('succeeds and preserves local keys when getKeyring fails on network error during loginVault', async () => {
    vi.mocked(getKeyring).mockRejectedValueOnce(new Error('Network offline'))

    await loginVault({
      account: 'test-account',
      password: 'password123',
      salt: SALT,
      saltVersion: 1,
      iterations: 1000,
    })

    // Keyring and vault state should be preserved
    expect(hasVaultKey('1')).toBe(true)
    // Stored metadata should be written
    const stored = localStorage.getItem(getVaultStorageNames().vaultMetadataKey)
    expect(stored).toBeDefined()
    expect(JSON.parse(stored!).account).toBe('test-account')
  })

  it('succeeds and preserves local keys when storeVault fails during loginVault for new account', async () => {
    vi.mocked(getKeyring).mockResolvedValueOnce({ randomDataKeys: false })
    vi.mocked(updateKeyring).mockRejectedValueOnce(new Error('Network error on seed'))

    await loginVault({
      account: 'test-account',
      password: 'password123',
      salt: SALT,
      saltVersion: 1,
      iterations: 1000,
    })

    // Keyring and vault state should be preserved
    expect(hasVaultKey('1')).toBe(true)
    // Stored metadata should be written
    const stored = localStorage.getItem(getVaultStorageNames().vaultMetadataKey)
    expect(stored).toBeDefined()
    expect(JSON.parse(stored!).account).toBe('test-account')
  })

  it('throws and clears local keys when decryption of retrieved keyring fails during loginVault', async () => {
    vi.mocked(getKeyring).mockResolvedValueOnce({
      keyring: JSON.stringify({
        iv: 'invalid-iv',
        cipher: 'invalid-cipher',
      }),
      randomDataKeys: false,
    })

    await expect(
      loginVault({
        account: 'test-account',
        password: 'password123',
        salt: SALT,
        saltVersion: 1,
        iterations: 1000,
      })
    ).rejects.toThrow(/Failed to decrypt keyring from server during login/)

    // Keyring and vault state should be wiped/cleared on decryption failure
    expect(hasVaultKey('1')).toBe(false)
  })

  it('persists encrypted keyring in local cache and clears it on clearVaultDeviceData', async () => {
    await initialiseVault({
      password: 'password123',
      salt: SALT,
      saltVersion: 1,
      iterations: 1000,
    })
    await storeVault('test-account')

    const cached = readCachedKeyring()
    expect(cached).toBeDefined()
    expect(localStorage.getItem(getVaultStorageNames().keyringCacheKey)).toBeDefined()

    await clearVaultDeviceData()
    expect(readCachedKeyring()).toBeNull()
    expect(localStorage.getItem(getVaultStorageNames().keyringCacheKey)).toBeNull()
  })

  it('throws when password cannot be verified (no cached keyring and server session fails)', async () => {
    vi.mocked(getSession).mockRejectedValueOnce(new Error('Invalid auth token'))

    await expect(
      loginVault({
        account: 'test-account',
        password: 'wrong-password',
        salt: SALT,
        saltVersion: 1,
        iterations: 1000,
      })
    ).rejects.toThrow(/Incorrect account ID or password/)

    expect(hasVaultKey('1')).toBe(false)
  })

  it('succeeds offline when cached keyring decryption validates the password', async () => {
    // First, login normally to seed the keyring cache
    await loginVault({
      account: 'test-account',
      password: 'password123',
      salt: SALT,
      saltVersion: 1,
      iterations: 1000,
    })

    const cachedKeyring = readCachedKeyring()
    expect(cachedKeyring).toBeDefined()

    // Clear memory keyring state, simulate offline
    await clearVaultDeviceData()
    // Restore the cached keyring
    localStorage.setItem(getVaultStorageNames().keyringCacheKey, cachedKeyring!)

    vi.mocked(getSession).mockRejectedValueOnce(new Error('Network offline'))
    vi.mocked(getKeyring).mockRejectedValueOnce(new Error('Network offline'))

    // Should succeed with correct password and cached keyring
    await loginVault({
      account: 'test-account',
      password: 'password123',
      salt: SALT,
      saltVersion: 1,
      iterations: 1000,
    })

    expect(hasVaultKey('1')).toBe(true)
  })

  describe('with a slow server', () => {
    const loginParams = {
      account: 'test-account',
      password: 'password123',
      salt: SALT,
      saltVersion: 1,
      iterations: 1000,
    }
    let respond: (session: string) => void

    beforeEach(async () => {
      // Drop responses queued by earlier tests that didn't use them
      vi.mocked(getSession).mockReset().mockResolvedValue('mock-session')
      vi.mocked(getKeyring).mockReset().mockResolvedValue({ randomDataKeys: false })

      // Log in once to seed the keyring cache, then forget the keys
      await loginVault(loginParams)
      const cachedKeyring = readCachedKeyring()!
      await clearVaultDeviceData()
      localStorage.setItem(getVaultStorageNames().keyringCacheKey, cachedKeyring)

      vi.mocked(getSession).mockImplementationOnce(() => new Promise(resolve => { respond = resolve }))
      vi.useFakeTimers({ toFake: ['setTimeout'] })
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    /** Runs timers until the promise settles, letting real crypto work progress in between */
    async function settle<T>(promise: Promise<T>): Promise<T> {
      let done = false
      promise.finally(() => { done = true }).catch(() => undefined)
      while (!done) {
        await new Promise(resolve => setImmediate(resolve))
        await vi.advanceTimersByTimeAsync(500)
      }
      return promise
    }

    it('unlocks with the cached keyring and finishes the session in the background', async () => {
      let notified: () => void = () => {}
      const lateSession = new Promise<void>(resolve => { notified = resolve })
      const stopListening = onLateSession(() => notified())

      await settle(loginVault(loginParams))
      expect(hasVaultKey('1')).toBe(true)
      expect(getVaultSession()).toBe('')

      respond('late-session')
      await settle(lateSession)
      expect(getVaultSession()).toBe('late-session')
      stopListening()
    })

    it('does not restore a session that arrives after locking', async () => {
      const lateSession = vi.fn()
      const stopListening = onLateSession(lateSession)

      await settle(loginVault(loginParams))
      await lockVaultKeys()

      respond('late-session')
      await new Promise(resolve => setImmediate(resolve))
      expect(getVaultSession()).toBe('')
      expect(lateSession).not.toHaveBeenCalled()
      stopListening()
    })
  })

  it('throws offline when incorrect password fails cached keyring decryption and server session fails', async () => {
    // First, login normally to seed the keyring cache
    await loginVault({
      account: 'test-account',
      password: 'password123',
      salt: SALT,
      saltVersion: 1,
      iterations: 1000,
    })

    const cachedKeyring = readCachedKeyring()
    expect(cachedKeyring).toBeDefined()

    // Clear memory keyring state, simulate offline
    await clearVaultDeviceData()
    // Restore the cached keyring
    localStorage.setItem(getVaultStorageNames().keyringCacheKey, cachedKeyring!)

    vi.mocked(getSession).mockRejectedValueOnce(new Error('Network offline'))
    vi.mocked(getKeyring).mockRejectedValueOnce(new Error('Network offline'))

    // Should fail with incorrect password
    await expect(
      loginVault({
        account: 'test-account',
        password: 'wrong-password',
        salt: SALT,
        saltVersion: 1,
        iterations: 1000,
      })
    ).rejects.toThrow(/Incorrect account ID or password/)

    expect(hasVaultKey('1')).toBe(false)
  })

  describe('Cross-tab key version utilities & storage reload', () => {
    it('correctly reports hasVaultKey for existing and missing versions', async () => {
      await initialiseVault({ password: 'password123', salt: SALT, saltVersion: 1, iterations: 1000 })
      expect(hasVaultKey('1')).toBe(true)
      expect(hasVaultKey()).toBe(true)
      expect(hasVaultKey('2')).toBe(false)
      expect(hasVaultKey('99')).toBe(false)
    })

    it('reloadKeyringFromStorage successfully decrypts and returns keyringData', async () => {
      await loginVault({
        account: 'test-account',
        password: 'password123',
        salt: SALT,
        saltVersion: 1,
        iterations: 1000,
      })
      await storeVault('test-account')

      const result = await reloadKeyringFromStorage()
      expect(result.success).toBe(true)
      expect(result.passwordChanged).toBeUndefined()
      expect(result.keyringData).toBeDefined()
    })

    it('reloadKeyringFromStorage detects passwordChanged when cached keyring cannot be decrypted', async () => {
      await loginVault({
        account: 'test-account',
        password: 'password123',
        salt: SALT,
        saltVersion: 1,
        iterations: 1000,
      })

      // Corrupt the cached keyring
      localStorage.setItem(getVaultStorageNames().keyringCacheKey, JSON.stringify({
        iv: 'invalid',
        cipher: 'invalid-cipher-data',
        kver: '1',
        version: '1.0',
      }))

      const result = await reloadKeyringFromStorage()
      expect(result.success).toBe(false)
      expect(result.passwordChanged).toBe(true)
    })
  })
})

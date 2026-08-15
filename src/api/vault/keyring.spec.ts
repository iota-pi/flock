import {
  initialiseVault,
  loginVault,
  initWorkerVault,
  getVaultKey,
  encrypt,
  decrypt,
  encryptBytes,
  decryptBytes,
  storeVault,
  loadAccount,
  lockVault,
  removeVaultFromDevice,
  rotateVaultKey,
  exportKeyringData,
  handleSessionExpired,
} from './index'
import { VAULT_STORAGE_KEY } from './util'
import { SyncBridge } from 'src/sync/client/SyncBridge'
import { clearActiveSessionToken } from '../../sync/shared/workerAuthStore'

import { updateKeyring, getKeyring } from './client'

vi.mock('./client', () => ({
  getSession: vi.fn().mockResolvedValue('mock-session'),
  createAccount: vi.fn(),
  getSecurityParams: vi.fn(),
  recordPrayerCompletion: vi.fn(),
  getKeyring: vi.fn().mockResolvedValue(undefined),
  updateKeyring: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../sync/shared/workerAuthStore', () => ({
  setActiveSessionToken: vi.fn(),
  getActiveSessionToken: vi.fn().mockResolvedValue('mock-session'),
  clearActiveSessionToken: vi.fn(),
}))

vi.mock('../util', () => ({
  getAccountId: () => 'test-account',
}))

describe('Vault Keyring Integration', () => {
  beforeEach(async () => {
    localStorage.clear()
    await removeVaultFromDevice()
    vi.clearAllMocks()
  })

  it('initializes vault and saves only account to localStorage, exporting keyring separately', async () => {
    const hash = await initialiseVault({
      password: 'password123',
      salt: 'salt123',
      iterations: 1000,
    })
    expect(hash).toBeDefined()
    expect(getVaultKey('1')).toBeDefined()

    await storeVault('test-account')

    const stored = localStorage.getItem(VAULT_STORAGE_KEY)
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

  it('loads only account from localStorage on loadVault, without loading keys', async () => {
    await initialiseVault({
      password: 'password123',
      salt: 'salt123',
      iterations: 1000,
    })
    await storeVault('test-account')

    // Clear memory keyring
    await removeVaultFromDevice()

    // Restore account only
    localStorage.setItem(VAULT_STORAGE_KEY, JSON.stringify({ account: 'test-account' }))

    // Load from storage
    await loadAccount()

    // keyring should be empty and getVaultKey should throw
    expect(() => getVaultKey('1')).toThrow()
  })

  it('loads worker vault using exported keyring', async () => {
    await initialiseVault({
      password: 'password123',
      salt: 'salt123',
      iterations: 1000,
    })

    const exported = await exportKeyringData()

    await removeVaultFromDevice()

    await initWorkerVault(exported)

    expect(getVaultKey('1')).toBeDefined()
    expect(getVaultKey()).toBeDefined()
  })

  it('automatically tags encrypted string with kver and decrypts correctly', async () => {
    await initialiseVault({
      password: 'password123',
      salt: 'salt123',
      iterations: 1000,
    })

    const enc = await encrypt('hello keyring')
    expect(enc.kver).toBe('1')

    const dec = await decrypt(enc)
    expect(dec).toBe('hello keyring')
  })

  it('automatically tags encrypted bytes with kver and decrypts correctly', async () => {
    await initialiseVault({
      password: 'password123',
      salt: 'salt123',
      iterations: 1000,
    })

    const bytes = new Uint8Array([1, 2, 3, 4, 5])
    const enc = await encryptBytes(bytes)
    expect(enc.kver).toBe('1')

    const dec = await decryptBytes(enc)
    expect(Array.from(dec)).toEqual([1, 2, 3, 4, 5])
  })

  it('gracefully falls back to version 1 when decrypting legacy data lacking kver', async () => {
    await initialiseVault({
      password: 'password123',
      salt: 'salt123',
      iterations: 1000,
    })

    const enc = await encrypt('legacy data')
    // Strip kver to simulate legacy unversioned data
    delete enc.kver

    const dec = await decrypt(enc)
    expect(dec).toBe('legacy data')
  })

  it('rotates vault key, updates activeKeyVersion, and encrypts/decrypts with new active key version', async () => {
    await initialiseVault({
      password: 'password123',
      salt: 'salt123',
      iterations: 1000,
    })

    const enc1 = await encrypt('data 1')
    expect(enc1.kver).toBe('1')

    await rotateVaultKey('test-account')

    const enc2 = await encrypt('data 2')
    expect(enc2.kver).toBe('2')

    // Both should decrypt correctly
    expect(await decrypt(enc1)).toBe('data 1')
    expect(await decrypt(enc2)).toBe('data 2')
  })

  it('rolls back local keyring and activeKeyVersion when keyring upload fails during rotation', async () => {
    await loginVault({
      account: 'test-account',
      password: 'password123',
      salt: 'salt123',
      iterations: 1000,
    })

    expect(getVaultKey('1')).toBeDefined()
    expect(() => getVaultKey('2')).toThrow()

    vi.mocked(updateKeyring).mockRejectedValueOnce(new Error('Network offline'))

    await expect(rotateVaultKey('test-account')).rejects.toThrow(
      'Key rotation failed: keyring upload unsuccessful. Local state rolled back. Cause: Network offline'
    )

    // Keyring must be rolled back to version 1
    expect(getVaultKey('1')).toBeDefined()
    expect(() => getVaultKey('2')).toThrow()

    // Keyring data activeVersion must be rolled back to 1
    const exported = await exportKeyringData()
    const parsed = JSON.parse(exported)
    expect(parsed.activeVersion).toBe('1')
    expect(parsed['2']).toBeUndefined()

    // Subsequent encryption should still use key version 1
    const enc = await encrypt('still on version 1')
    expect(enc.kver).toBe('1')
  })

  it('locks vault without clearing stored metadata and clears active session token', async () => {
    const shutdownSpy = vi.spyOn(SyncBridge, 'shutdown').mockResolvedValue(undefined)
    await initialiseVault({
      password: 'password123',
      salt: 'salt123',
      iterations: 1000,
    })
    await storeVault('test-account')

    await lockVault()

    // keyring should be cleared
    expect(() => getVaultKey('1')).toThrow()

    // stored metadata should still exist
    const stored = localStorage.getItem(VAULT_STORAGE_KEY)
    expect(stored).toBeDefined()
    expect(JSON.parse(stored!).account).toBe('test-account')

    // active session token should be cleared
    expect(clearActiveSessionToken).toHaveBeenCalled()

    // SyncBridge.shutdown should be called with clearLocalData: false
    expect(shutdownSpy).toHaveBeenCalledWith({ clearLocalData: false })
  })

  it('handleSessionExpired locks vault and preserves stored metadata and offline data instead of wiping', async () => {
    const shutdownSpy = vi.spyOn(SyncBridge, 'shutdown').mockResolvedValue(undefined)
    await initialiseVault({
      password: 'password123',
      salt: 'salt123',
      iterations: 1000,
    })
    await storeVault('test-account')

    await handleSessionExpired()

    // keyring should be locked/cleared
    expect(() => getVaultKey('1')).toThrow()

    // stored metadata MUST NOT be wiped
    const stored = localStorage.getItem(VAULT_STORAGE_KEY)
    expect(stored).toBeDefined()
    expect(JSON.parse(stored!).account).toBe('test-account')

    // SyncBridge.shutdown MUST NOT wipe local data
    expect(shutdownSpy).toHaveBeenCalledWith({ clearLocalData: false })
    expect(shutdownSpy).not.toHaveBeenCalledWith({ clearLocalData: true })
  })

  it('throws and clears local keys when getKeyring fails on network error during loginVault', async () => {
    vi.mocked(getKeyring).mockRejectedValueOnce(new Error('Network offline'))

    await expect(
      loginVault({
        account: 'test-account',
        password: 'password123',
        salt: 'salt123',
        iterations: 1000,
      })
    ).rejects.toThrow('Failed to retrieve keyring from server during login: Network offline')

    // Keyring and vault state should be wiped/cleared
    expect(() => getVaultKey('1')).toThrow()
    // Stored metadata should not be written
    expect(localStorage.getItem(VAULT_STORAGE_KEY)).toBeNull()
  })

  it('throws and clears local keys when storeVault fails during loginVault for new account', async () => {
    vi.mocked(getKeyring).mockResolvedValueOnce(undefined)
    vi.mocked(updateKeyring).mockRejectedValueOnce(new Error('Network error on seed'))

    await expect(
      loginVault({
        account: 'test-account',
        password: 'password123',
        salt: 'salt123',
        iterations: 1000,
      })
    ).rejects.toThrow('Failed to seed keyring to server during login: Network error on seed')

    // Keyring and vault state should be wiped/cleared
    expect(() => getVaultKey('1')).toThrow()
  })
})

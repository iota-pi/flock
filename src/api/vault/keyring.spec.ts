import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  initialiseVault,
  initWorkerVault,
  getVaultKey,
  encrypt,
  decrypt,
  encryptBytes,
  decryptBytes,
  storeVault,
  loadVault,
  signOutVault
} from './index'
import { VAULT_STORAGE_KEY } from './util'

vi.mock('./client', () => ({
  getSession: vi.fn().mockResolvedValue('mock-session'),
  createAccount: vi.fn(),
  getSecurityParams: vi.fn(),
  recordPrayerCompletion: vi.fn(),
}))

vi.mock('../../sync/workerAuthStore', () => ({
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
    await signOutVault()
    vi.clearAllMocks()
  })

  it('initializes vault and saves keyring to localStorage', async () => {
    const hash = await initialiseVault({
      password: 'password123',
      salt: 'salt123',
      iterations: 1000,
    })
    expect(hash).toBeDefined()
    expect(getVaultKey('1')).toBeDefined()

    await storeVault()

    const stored = localStorage.getItem(VAULT_STORAGE_KEY)
    expect(stored).toBeDefined()
    
    const parsed = JSON.parse(stored!)
    expect(parsed.account).toBe('test-account')
    
    const keyData = JSON.parse(parsed.key)
    expect(keyData.activeVersion).toBe('1')
    expect(keyData['1']).toBeDefined()
  })

  it('loads vault from versioned keyring in localStorage', async () => {
    await initialiseVault({
      password: 'password123',
      salt: 'salt123',
      iterations: 1000,
    })
    await storeVault()

    // Backup storage before clearing keyring
    const backup = localStorage.getItem(VAULT_STORAGE_KEY)

    // Clear memory keyring
    await signOutVault()

    // Restore storage
    localStorage.setItem(VAULT_STORAGE_KEY, backup!)

    // Load from storage
    await loadVault()

    expect(getVaultKey('1')).toBeDefined()
    expect(getVaultKey()).toBeDefined()
  })

  it('loads worker vault using exported keyring', async () => {
    await initialiseVault({
      password: 'password123',
      salt: 'salt123',
      iterations: 1000,
    })
    await storeVault()
    
    // Construct serialized keyring
    const mockStorage = localStorage.getItem(VAULT_STORAGE_KEY)
    const parsed = JSON.parse(mockStorage!)
    
    await signOutVault()
    
    await initWorkerVault(parsed.key)

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
})

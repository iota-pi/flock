import type { AxiosInstance } from 'axios'
import store from '../store'
import { getBlankPerson } from '../state/items'
import * as axios from './axios'
import * as vault from './Vault'
import { setAccount } from '../state/account'
import { queryClient, queryKeys } from './client'
import { getSalt } from './crypto-utils'

const VAULT_TEST_PARAMS = {
  password: 'example',
  salt: 'example123',
  isNewAccount: true,
  iterations: 100,
}

describe('Vault', () => {
  beforeAll(
    async () => {
      vi.spyOn(vault, 'storeVault').mockImplementation(() => Promise.resolve())
      vi.spyOn(vault, 'loadVault').mockImplementation(() => Promise.resolve())

      vi.spyOn(axios, 'getAxios').mockImplementation(() => ({
        put: vi.fn(() => ({ data: { success: true, details: [] } })),
        delete: vi.fn(() => ({ data: { success: true, details: [] } })),
      }) as unknown as AxiosInstance)

      store.dispatch(setAccount({ account: '.' }))
      await vault.initialiseVault(VAULT_TEST_PARAMS)
    },
    10000,
  )

  beforeEach(() => {
    queryClient.clear()
  })

  it('encrypt and decrypt', async () => {
    const text = 'It came to me on my birthday, my precious.'
    const cipher = await vault.encrypt(text)
    const result = await vault.decrypt(cipher)
    expect(result).toEqual(text)
  })

  it('encryptObject and decryptObject', async () => {
    const obj = { id: 'onering' }
    const cipher = await vault.encryptObject(obj)
    const result = await vault.decryptObject(cipher)
    expect(result).toEqual(obj)
  })

  it('getSalt returns a non-empty, changing string', () => {
    const a = getSalt()
    const b = getSalt()
    expect(typeof a).toBe('string')
    expect(a.length).toBeGreaterThan(0)
    expect(b.length).toBeGreaterThan(0)
    expect(a).not.toBe(b)
  })

  it('signOutVault clears localStorage and resets axios/store', async () => {
    localStorage.setItem(vault.VAULT_KEY_STORAGE_KEY, 'somekey')
    store.dispatch(setAccount({ account: 'acct' } as any))
    queryClient.setQueryData(queryKeys.items, [getBlankPerson() as any])

    const initSpy = vi.spyOn(axios as any, 'initAxios')

    try {
      vault.signOutVault()

      expect(localStorage.getItem(vault.VAULT_KEY_STORAGE_KEY)).toBeNull()
      expect(queryClient.getQueryData(queryKeys.items)).toBeUndefined()
      expect(initSpy).toHaveBeenCalledWith('')
      initSpy.mockRestore()
    } finally {
      await vault.initialiseVault(VAULT_TEST_PARAMS)
    }
  })

  it('exportData and importData roundtrip items', async () => {
    const items = [getBlankPerson()]
    const exported = await vault.exportData(items)
    expect(exported.cipher).toBeTruthy()
    const imported = await vault.importData(exported)
    expect(imported).toEqual(items)
  })
})

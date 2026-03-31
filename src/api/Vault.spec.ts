import { getBlankPerson } from '../state/items'
import * as runtime from './runtime'
import * as vault from './vault'
import { queryClient, queryKeys } from './queryClient'
import { getSalt } from './crypto-utils'
import { useAuthStore } from '../state/authStore'

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

      useAuthStore.getState().setAccount({ account: '.' })
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

  it('decryptObject', async () => {
    const obj = { id: 'onering' }
    const cipher = await vault.encrypt(JSON.stringify(obj))
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

  it('signOutVault clears localStorage and resets auth token/store', async () => {
    localStorage.setItem(vault.VAULT_STORAGE_KEY, JSON.stringify({ account: 'acct', key: 'somekey' }))
    useAuthStore.getState().setAccount({ account: 'acct' })
    queryClient.setQueryData(queryKeys.items, [getBlankPerson() as any])

    const setAuthTokenSpy = vi.spyOn(runtime, 'setApiAuthToken')

    try {
      vault.signOutVault()

      expect(localStorage.getItem(vault.VAULT_STORAGE_KEY)).toBeNull()
      expect(queryClient.getQueryData(queryKeys.items)).toBeUndefined()
      expect(setAuthTokenSpy).toHaveBeenCalledWith('')
      setAuthTokenSpy.mockRestore()
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

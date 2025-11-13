import type { AxiosInstance } from 'axios'
import { vi } from 'vitest'
import store from '../store'
import { getBlankGroup, getBlankPerson, Item, setItems } from '../state/items'
import * as axios from './axios'
import * as vault from './Vault'
import * as api from './VaultAPI'
import type { VaultItem } from './VaultAPI'
import { setAccount, type AccountMetadata } from '../state/account'

describe('Vault (Crypto)', () => {
  beforeAll(
    async () => {
      vi.spyOn(vault, 'storeVault').mockImplementation(() => Promise.resolve())
      vi.spyOn(vault, 'loadVault').mockImplementation(() => Promise.resolve())

      vi.spyOn(vault, 'getItemCacheTime').mockImplementation(() => null)
      vi.spyOn(vault, 'mergeWithItemCache').mockImplementation(() => Promise.resolve([]))
      vi.spyOn(vault, 'setItemCache').mockImplementation(() => {})
      vi.spyOn(vault, 'clearItemCache').mockImplementation(() => {})
      vi.spyOn(vault, 'checkItemCache').mockReturnValue(false)
      vi.spyOn(axios, 'getAxios').mockImplementation(() => ({
        put: vi.fn(() => ({ data: { success: true } })),
      }) as unknown as AxiosInstance)

      store.dispatch(setAccount({ account: '.' }))
      await vault.initialiseVault({
        password: 'example',
        salt: 'example123',
        isNewAccount: true,
        iterations: 100,
      })
    },
    10000,
  )

  beforeEach(() => {
    store.dispatch(setItems([]))
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

  it('store a single item', async () => {
    const item = getBlankPerson()
    await vault.storeItems(item)
    expect(store.getState().items.ids).toContain(item.id)
  })

  it('store multiple items', async () => {
    const items = [getBlankPerson(), getBlankGroup()]
    await vault.storeItems(items)
    expect(store.getState().items.ids).toContain(items[0].id)
    expect(store.getState().items.ids).toContain(items[1].id)
  })

  it('does not store items with missing properties (single)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { description, ...item } = getBlankPerson()
    await expect(vault.storeItems(item as Item)).rejects.toThrow()
  })

  it('does not store items with missing properties (many)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { description, ...partialItem } = getBlankPerson()
    const items = [getBlankPerson(), getBlankGroup(), partialItem as Item]

    const promise = vault.storeItems(items)
    await expect(promise).rejects.toThrow()
  })

  it('fetchAll', async () => {
    const original = [getBlankPerson(), getBlankGroup()]
    const encrypted = await Promise.all(original.map(item => vault.encryptObject(item)))
    const asAPIItems: VaultItem[] = encrypted.map((item, i) => ({
      account: '.',
      cipher: item.cipher,
      item: original[i].id,
      metadata: {
        iv: item.iv,
        type: original[i].type,
        modified: new Date().getTime(),
      },
    }))

    vi.spyOn(api, 'vaultFetchMany').mockReturnValue(Promise.resolve(asAPIItems))

    const result = await vault.fetchAll()
    expect(result).toEqual(original)
  })

  it('delete a single item', async () => {
    const item = getBlankPerson()
    await vault.storeItems(item)

    const deleteAPI = vi.spyOn(api, 'vaultDelete').mockReturnValue(Promise.resolve())

    await vault.deleteItems(item.id)

    expect(store.getState().items.ids).toHaveLength(0)
    const apiCallParam = deleteAPI.mock.calls[0][0]
    expect(apiCallParam).toMatchObject({
      item: item.id,
    })
  })

  it('delete multiple items', async () => {
    const items = [getBlankPerson(), getBlankPerson(), getBlankPerson()]
    await vault.storeItems(items)

    const deleteAPI = vi.spyOn(api, 'vaultDeleteMany').mockReturnValue(Promise.resolve())

    await vault.deleteItems([items[1].id, items[2].id])

    expect(store.getState().items.ids).toHaveLength(1)
    const apiCallParam = deleteAPI.mock.calls[0][0]
    expect(apiCallParam).toMatchObject({
      items: [items[1].id, items[2].id],
    })
  })

  it('setMetadata', async () => {
    const metadata: AccountMetadata = { prayerGoal: 1, completedMigrations: [] }
    const metadataAPI = vi.spyOn(api, 'vaultSetMetadata').mockReturnValue(Promise.resolve(true))

    await vault.setMetadata(metadata)

    expect(store.getState().account).toMatchObject({ metadata })
    const apiCallParam = metadataAPI.mock.calls[0][0]
    const decrypted = await vault.decryptObject(
      apiCallParam as vault.CryptoResult,
    )
    expect(decrypted).toMatchObject(metadata)
  })

  it('getMetadata', async () => {
    const original: AccountMetadata = { prayerGoal: 1, completedMigrations: ['foo'] }
    const encrypted = await vault.encryptObject(original)
    vi.spyOn(api, 'vaultGetMetadata').mockReturnValue(Promise.resolve(encrypted))

    const result = await vault.getMetadata()

    expect(result).toEqual(original)
    expect(store.getState().account.metadata).toMatchObject(original)
  })

  it('getMetadata plain', async () => {
    const original: AccountMetadata = { prayerGoal: 1, completedMigrations: ['foo'] }
    vi.spyOn(api, 'vaultGetMetadata').mockReturnValue(Promise.resolve(original))

    const result = await vault.getMetadata()

    expect(result).toEqual(original)
    expect(store.getState().account.metadata).toMatchObject(original)
  })

  it('getMetadata throws', async () => {
    const original: AccountMetadata = { prayerGoal: 1, completedMigrations: ['foo'] }
    const encrypted = await vault.encryptObject(original)
    encrypted.cipher = 'corrupted cipher text'
    vi.spyOn(api, 'vaultGetMetadata').mockReturnValue(Promise.resolve(encrypted))

    const promise = vault.getMetadata()
    await expect(promise).rejects.toThrow()
  })
})

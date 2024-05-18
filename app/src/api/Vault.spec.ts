import store from '../store'
import { getBlankGroup, getBlankPerson, Item, setItems } from '../state/items'
import * as vault from './Vault'
import * as common from './common'
import * as api from './VaultAPI'
import type { VaultItem } from './VaultAPI'
import { setAccount, type AccountMetadata } from '../state/account'
import { AxiosInstance } from 'axios'

describe('Vault (Crypto)', () => {
  beforeAll(
    async () => {
      jest.spyOn(vault, 'storeVault').mockImplementation(() => Promise.resolve())
      jest.spyOn(vault, 'loadVault').mockImplementation(() => Promise.resolve())

      jest.spyOn(vault, 'getItemCacheTime').mockImplementation(() => null)
      jest.spyOn(vault, 'mergeWithItemCache').mockImplementation(() => Promise.resolve([]))
      jest.spyOn(vault, 'setItemCache').mockImplementation(() => {})
      jest.spyOn(vault, 'clearItemCache').mockImplementation(() => {})
      jest.spyOn(vault, 'checkItemCache').mockReturnValue(false)
      jest.spyOn(common, 'getAxios').mockImplementation(() => ({
        put: jest.fn(() => ({ data: { success: true } })),
      }) as unknown as AxiosInstance)

      store.dispatch(setAccount({ account: '.' }))
      await vault.initialiseVault(
        'example',
        true,
        100,
      )
    },
    10000,
  )

  beforeEach(() => {
    store.dispatch(setItems([]))
  })

  test('encrypt and decrypt', async () => {
    const text = 'It came to me on my birthday, my precious.'
    const cipher = await vault.encrypt(text)
    const result = await vault.decrypt(cipher)
    expect(result).toEqual(text)
  })

  test('encryptObject and decryptObject', async () => {
    const obj = { id: 'onering' }
    const cipher = await vault.encryptObject(obj)
    const result = await vault.decryptObject(cipher)
    expect(result).toEqual(obj)
  })

  test('store a single item', async () => {
    const item = getBlankPerson()
    await vault.storeItems(item)
    expect(store.getState().items.ids).toContain(item.id)
  })

  test('store multiple items', async () => {
    const items = [getBlankPerson(), getBlankGroup()]
    await vault.storeItems(items)
    expect(store.getState().items.ids).toContain(items[0].id)
    expect(store.getState().items.ids).toContain(items[1].id)
  })

  test('does not store items with missing properties (single)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { description, ...item } = getBlankPerson()
    await expect(vault.storeItems(item as Item)).rejects.toThrow()
  })

  test('does not store items with missing properties (many)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { description, ...partialItem } = getBlankPerson()
    const items = [getBlankPerson(), getBlankGroup(), partialItem as Item]

    const promise = vault.storeItems(items)
    await expect(promise).rejects.toThrow()
  })

  test('fetchAll', async () => {
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

    jest.spyOn(api, 'vaultFetchMany').mockReturnValue(Promise.resolve(asAPIItems))

    const result = await vault.fetchAll()
    expect(result).toEqual(original)
  })

  test('delete a single item', async () => {
    const item = getBlankPerson()
    await vault.storeItems(item)

    const deleteAPI = jest.spyOn(api, 'vaultDelete').mockReturnValue(Promise.resolve())

    await vault.deleteItems(item.id)

    expect(store.getState().items.ids).toHaveLength(0)
    const apiCallParams = deleteAPI.mock.calls[0][0]
    expect(apiCallParams).toMatchObject({
      item: item.id,
    })
  })

  test('delete multiple items', async () => {
    const items = [getBlankPerson(), getBlankPerson(), getBlankPerson()]
    await vault.storeItems(items)

    const deleteAPI = jest.spyOn(api, 'vaultDeleteMany').mockReturnValue(Promise.resolve())

    await vault.deleteItems([items[1].id, items[2].id])

    expect(store.getState().items.ids).toHaveLength(1)
    const apiCallParams = deleteAPI.mock.calls[0][0]
    expect(apiCallParams).toMatchObject({
      items: [items[1].id, items[2].id],
    })
  })

  test('setMetadata', async () => {
    const metadata: AccountMetadata = { prayerGoal: 1, completedMigrations: [] }
    const metadataAPI = jest.spyOn(api, 'vaultSetMetadata').mockReturnValue(Promise.resolve(true))

    await vault.setMetadata(metadata)

    expect(store.getState().account).toMatchObject({ metadata })
    const apiCallParams = metadataAPI.mock.calls[0][0]
    const decrypted = await vault.decryptObject(
      apiCallParams.metadata as vault.CryptoResult,
    )
    expect(decrypted).toMatchObject(metadata)
  })

  test('getMetadata', async () => {
    const original: AccountMetadata = { prayerGoal: 1, completedMigrations: ['foo'] }
    const encrypted = await vault.encryptObject(original)
    jest.spyOn(api, 'vaultGetMetadata').mockReturnValue(Promise.resolve(encrypted))

    const result = await vault.getMetadata()

    expect(result).toEqual(original)
    expect(store.getState().account.metadata).toMatchObject(original)
  })

  test('getMetadata plain', async () => {
    const original: AccountMetadata = { prayerGoal: 1, completedMigrations: ['foo'] }
    jest.spyOn(api, 'vaultGetMetadata').mockReturnValue(Promise.resolve(original))

    const result = await vault.getMetadata()

    expect(result).toEqual(original)
    expect(store.getState().account.metadata).toMatchObject(original)
  })
})

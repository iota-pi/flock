import type { CryptoResult } from '@vault/client'
import type { LegacyItemContext } from '@vault/client/worker'
import type { ItemId } from '@vault/shared'
import { decodeLegacyCipherItem } from './legacyItems'

const ITEM_ID = 'item-1' as ItemId
const IV = 'test-iv'

describe('decodeLegacyCipherItem', () => {
  const ensureKey = vi.fn(async () => true)
  // Stands in for the keyring: the "ciphertext" is the base64 of the plaintext
  const decrypt = vi.fn(async ({ iv, cipher }: CryptoResult) => {
    if (iv !== IV) throw new Error('Wrong IV')
    return Uint8Array.from(atob(cipher), c => c.charCodeAt(0))
  })
  let context: LegacyItemContext

  beforeEach(() => {
    ensureKey.mockClear()
    decrypt.mockClear()
    context = { ensureKey, decrypt }
  })

  function legacyRow(payload: unknown) {
    const cipher = btoa(JSON.stringify(payload))
    return { item: ITEM_ID, cipher, metadata: { iv: IV, kver: '1', modified: 1000 } }
  }

  it('decrypts the JSON blob in the row', async () => {
    const row = legacyRow({ id: 'item-1', type: 'person', name: 'Alice' })

    await expect(decodeLegacyCipherItem(row, context)).resolves.toEqual({ id: 'item-1', type: 'person', name: 'Alice' })
    expect(ensureKey).toHaveBeenCalledWith('1')
    expect(decrypt).toHaveBeenCalledWith({ iv: IV, cipher: row.cipher, kver: '1' })
  })

  it('ignores rows without a legacy payload', async () => {
    const row = legacyRow({ id: 'item-1' })

    await expect(decodeLegacyCipherItem({ item: ITEM_ID, metadata: { iv: '', modified: 1000 } }, context))
      .resolves.toBeNull()
    await expect(decodeLegacyCipherItem({ ...row, metadata: { modified: 1000 } }, context))
      .resolves.toBeNull()
    expect(ensureKey).not.toHaveBeenCalled()
  })

  it('ignores payloads that are not objects', async () => {
    const row = legacyRow(['not', 'an', 'item'])
    await expect(decodeLegacyCipherItem(row, context)).resolves.toBeNull()
  })

  it('fails on a payload it cannot decrypt', async () => {
    const row = legacyRow({ id: 'item-1' })
    await expect(decodeLegacyCipherItem({ ...row, metadata: { ...row.metadata, iv: 'other-iv' } }, context))
      .rejects.toThrow('Wrong IV')
  })
})

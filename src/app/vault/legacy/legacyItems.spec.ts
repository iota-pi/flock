import { generateVaultKey } from '@vault/client/crypto'
import { Keyring } from '@vault/client/Keyring'
import type { LegacyItemContext } from '@vault/client/sync/worker/domain'
import type { ItemId } from '@vault/shared/ids'
import { decodeLegacyCipherItem } from './legacyItems'

const ITEM_ID = 'item-1' as ItemId

describe('decodeLegacyCipherItem', () => {
  const keyring = new Keyring()
  const ensureKey = vi.fn(async () => true)
  let context: LegacyItemContext

  beforeEach(async () => {
    ensureKey.mockClear()
    keyring.replace(new Map([['1', await generateVaultKey()]]), '1')
    context = { ensureKey, decrypt: payload => keyring.decryptBytes(payload) }
  })

  async function legacyRow(payload: unknown) {
    const { iv, cipher, kver } = await keyring.encrypt(JSON.stringify(payload))
    return { item: ITEM_ID, cipher, metadata: { iv, kver, modified: 1000 } }
  }

  it('decrypts the JSON blob in the row', async () => {
    const row = await legacyRow({ id: 'item-1', type: 'person', name: 'Alice' })

    await expect(decodeLegacyCipherItem(row, context)).resolves.toEqual({ id: 'item-1', type: 'person', name: 'Alice' })
    expect(ensureKey).toHaveBeenCalledWith('1')
  })

  it('ignores rows without a legacy payload', async () => {
    const row = await legacyRow({ id: 'item-1' })

    await expect(decodeLegacyCipherItem({ item: ITEM_ID, metadata: { iv: '', modified: 1000 } }, context))
      .resolves.toBeNull()
    await expect(decodeLegacyCipherItem({ ...row, metadata: { modified: 1000 } }, context))
      .resolves.toBeNull()
    expect(ensureKey).not.toHaveBeenCalled()
  })

  it('ignores payloads that are not objects', async () => {
    const row = await legacyRow(['not', 'an', 'item'])
    await expect(decodeLegacyCipherItem(row, context)).resolves.toBeNull()
  })

  it('fails on a payload it cannot decrypt', async () => {
    const row = await legacyRow({ id: 'item-1' })
    await expect(decodeLegacyCipherItem({ ...row, cipher: 'AAAA' }, context)).rejects.toThrow()
  })
})

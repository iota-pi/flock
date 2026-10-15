import { clearVaultDeviceData, exportData, initialiseVault } from '../../../api/vault'
import type { ItemId } from '../../../shared/vault/ids'
import { decodeLegacyCipherItem } from './legacyItems'

const ITEM_ID = 'item-1' as ItemId

vi.mock('../../../sync/shared/workerAuthStore', () => ({
  setActiveSessionToken: vi.fn(),
  getActiveSessionToken: vi.fn().mockResolvedValue(''),
  clearActiveSessionToken: vi.fn(),
}))

describe('decodeLegacyCipherItem', () => {
  const ensureKey = vi.fn(async () => true)

  beforeEach(async () => {
    localStorage.clear()
    await clearVaultDeviceData()
    ensureKey.mockClear()
    await initialiseVault({ password: 'password123', salt: 'c2FsdDEyMw==', saltVersion: 1, iterations: 1000 })
  })

  async function legacyRow(payload: unknown) {
    const { iv, cipher, kver } = await exportData(payload)
    return { item: ITEM_ID, cipher, metadata: { iv, kver, modified: 1000 } }
  }

  it('decrypts the JSON blob in the row', async () => {
    const row = await legacyRow({ id: 'item-1', type: 'person', name: 'Alice' })

    await expect(decodeLegacyCipherItem(row, { ensureKey })).resolves.toEqual({ id: 'item-1', type: 'person', name: 'Alice' })
    expect(ensureKey).toHaveBeenCalledWith('1')
  })

  it('ignores rows without a legacy payload', async () => {
    const row = await legacyRow({ id: 'item-1' })

    await expect(decodeLegacyCipherItem({ item: ITEM_ID, metadata: { iv: '', modified: 1000 } }, { ensureKey }))
      .resolves.toBeNull()
    await expect(decodeLegacyCipherItem({ ...row, metadata: { modified: 1000 } }, { ensureKey }))
      .resolves.toBeNull()
    expect(ensureKey).not.toHaveBeenCalled()
  })

  it('ignores payloads that are not objects', async () => {
    const row = await legacyRow(['not', 'an', 'item'])
    await expect(decodeLegacyCipherItem(row, { ensureKey })).resolves.toBeNull()
  })

  it('fails on a payload it cannot decrypt', async () => {
    const row = await legacyRow({ id: 'item-1' })
    await expect(decodeLegacyCipherItem({ ...row, cipher: 'AAAA' }, { ensureKey })).rejects.toThrow()
  })
})

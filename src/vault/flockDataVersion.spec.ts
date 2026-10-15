import { flockDataVersionPolicy } from './flockDataVersion'
import type { ItemFormatSummary } from '@vault/server/drivers/base'

const migratedAccount = {
  account: 'acct-1',
  authToken: 'token',
  salt: 'salt',
  iterations: 600_000,
  saltVersion: 1,
}

function findBlockers(accountData: Record<string, unknown> = {}, items: Partial<ItemFormatSummary>[] = []) {
  const vault = {
    listItemFormats: vi.fn(async () => items.map((item, index) => ({
      itemId: `item-${index}`,
      deleted: false,
      hasSnapshot: true,
      snapshotFormat: 2,
      hasCipher: false,
      ...item,
    }))),
  }
  return flockDataVersionPolicy.findBlockers({
    account: 'acct-1',
    accountData: { ...migratedAccount, ...accountData },
    vault: vault as any,
  })
}

describe('flockDataVersionPolicy', () => {
  it('finds nothing to migrate for an account on the current formats', async () => {
    await expect(findBlockers({ metadata: {} }, [{}, { deleted: true, hasSnapshot: false }])).resolves.toEqual([])
  })

  it('needs plaintext settings to be moved into the settings document', async () => {
    await expect(findBlockers({ metadata: { prayerGoal: 5 } })).resolves.toEqual(['legacySettings'])
  })

  it('ignores leftover plaintext keys that are not synced settings', async () => {
    await expect(findBlockers({ metadata: { updatedAt: 1 } })).resolves.toEqual([])
  })

  it('needs the current key derivation', async () => {
    await expect(findBlockers({ saltVersion: undefined })).resolves.toEqual(['legacyKeyDerivation'])
    await expect(findBlockers({ iterations: undefined })).resolves.toEqual(['legacyKeyDerivation'])
  })

  it('needs snapshots bound to their document and no pre-Automerge items', async () => {
    await expect(findBlockers({}, [{ snapshotFormat: undefined }])).resolves.toEqual(['unboundSnapshots'])
    await expect(findBlockers({}, [{ hasSnapshot: false, hasCipher: true }])).resolves.toEqual(['legacyCipherItems'])
  })

  it('ignores items that kept a pre-Automerge payload alongside a snapshot', async () => {
    await expect(findBlockers({}, [{ hasCipher: true }])).resolves.toEqual([])
  })

  it('ignores deleted items, which are never decrypted', async () => {
    await expect(findBlockers({}, [
      { deleted: true, snapshotFormat: undefined },
      { deleted: true, hasSnapshot: false, hasCipher: true },
    ])).resolves.toEqual([])
  })
})

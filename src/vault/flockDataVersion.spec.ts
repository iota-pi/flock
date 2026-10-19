import { flockDataVersionPolicy } from './flockDataVersion'
import { FLOCK_DATA_VERSION } from '../shared/flockDataVersion'
import type { ItemFormatSummary } from '@vault/server'

const ARGON2ID = { algorithm: 'argon2id' as const, memoryKiB: 65536, passes: 3, parallelism: 1 }

const migratedAccount = {
  account: 'acct-1',
  authToken: 'token',
  salt: 'salt',
  saltVersion: 1,
  kdf: ARGON2ID,
  keyringVersion: 2,
}

function findBlockers(accountData: Record<string, unknown> = {}, items: Partial<ItemFormatSummary>[] = []) {
  const vault = {
    listItemFormats: vi.fn(async () => items.map((item, index) => ({
      itemId: `item-${index}`,
      deleted: false,
      hasSnapshot: true,
      snapshotFormat: 2,
      snapshotKver: '2',
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

  it('needs Argon2id key derivation', async () => {
    await expect(findBlockers({ kdf: undefined, iterations: 600_000 })).resolves.toEqual(['legacyKeyDerivation'])
  })

  it('needs data off the password-derived key v1', async () => {
    // Never rotated, so v1 is still the active key
    await expect(findBlockers({ keyringVersion: 1 })).resolves.toEqual(['passwordDerivedDataKey'])
    await expect(findBlockers({ keyringVersion: undefined })).resolves.toEqual(['passwordDerivedDataKey'])
    // Rotated, but not every snapshot re-encrypted yet (snapshots without a version are v1)
    await expect(findBlockers({}, [{ snapshotKver: '1' }])).resolves.toEqual(['passwordDerivedDataKey'])
    await expect(findBlockers({}, [{ snapshotKver: undefined }])).resolves.toEqual(['passwordDerivedDataKey'])
  })

  it('ignores v1 on accounts created with random data keys', async () => {
    await expect(findBlockers({ randomDataKeys: true, keyringVersion: 1 }, [{ snapshotKver: '1' }])).resolves.toEqual([])
  })

  it('ignores v1 snapshots of deleted items and items without a snapshot', async () => {
    await expect(findBlockers({}, [
      { deleted: true, snapshotKver: '1' },
      { hasSnapshot: false, snapshotKver: undefined },
    ])).resolves.toEqual([])
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

  describe('newAccountVersion', () => {
    const kdf = { algorithm: 'argon2id' as const, memoryKiB: 65536, passes: 3, parallelism: 1 }

    it('starts an account created with Argon2id and a keyring at the current version', () => {
      expect(flockDataVersionPolicy.newAccountVersion?.({ kdf, keyring: 'keyring', randomDataKeys: true }))
        .toBe(FLOCK_DATA_VERSION)
    })

    it('starts an account created the old way at the first version, so it still gets migrated', () => {
      expect(flockDataVersionPolicy.newAccountVersion?.({})).toBe(1)
      expect(flockDataVersionPolicy.newAccountVersion?.({ kdf })).toBe(1)
      expect(flockDataVersionPolicy.newAccountVersion?.({ keyring: 'keyring' })).toBe(1)
    })
  })
})

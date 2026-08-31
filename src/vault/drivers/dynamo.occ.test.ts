import DynamoDriver, { getConnectionParams } from './dynamo'
import { generateItemId } from '../../utils'
import { generateAccountId } from '../util'
import type { ItemType } from 'src/shared/itemTypes'
import { VersionConflictError } from '../../shared/syncErrors'

const driver = new DynamoDriver()

describe('DynamoDriver OCC & Conditional Cursors', () => {
  beforeAll(() => {
    driver.connect(getConnectionParams())
  })

  describe('Item Snapshot OCC Versioning', () => {
    it('succeeds on first write to new item and sets version to 1', async () => {
      const account = generateAccountId()
      const item = generateItemId()
      const type: ItemType = 'person'
      const cipher = 'first-write'
      const iv = 'iv-1'
      const modified = Date.now()

      await driver.set({ account, item, cipher, metadata: { type, iv, modified } })
      const stored = await driver.get({ account, item })

      expect(stored.version).toBe(1)
      expect(stored.cipher).toBe('first-write')
    })

    it('succeeds on second write when expected version matches and increments version to 2', async () => {
      const account = generateAccountId()
      const item = generateItemId()
      const type: ItemType = 'person'
      const modified = Date.now()

      await driver.set({ account, item, cipher: 'v1', metadata: { type, iv: 'iv-1', modified } })
      const first = await driver.get({ account, item })
      expect(first.version).toBe(1)

      // Write v2 with version: 1
      await driver.set({ account, item, cipher: 'v2', metadata: { type, iv: 'iv-2', modified: modified + 100 }, version: 1 })
      const second = await driver.get({ account, item })

      expect(second.version).toBe(2)
      expect(second.cipher).toBe('v2')
    })

    it('throws VersionConflictError when writing with a stale version', async () => {
      const account = generateAccountId()
      const item = generateItemId()
      const type: ItemType = 'person'
      const modified = Date.now()

      // Create v1
      await driver.set({ account, item, cipher: 'v1', metadata: { type, iv: 'iv-1', modified } })

      // Advance to v2
      await driver.set({ account, item, cipher: 'v2', metadata: { type, iv: 'iv-2', modified: modified + 100 }, version: 1 })

      // Client A tries to write using stale version 1
      await expect(
        driver.set({ account, item, cipher: 'v3-stale', metadata: { type, iv: 'iv-3', modified: modified + 200 }, version: 1 })
      ).rejects.toThrow(VersionConflictError)

      // Verify the item is still v2
      const current = await driver.get({ account, item })
      expect(current.version).toBe(2)
      expect(current.cipher).toBe('v2')
    })

    it('throws VersionConflictError when writing without version to an already existing item', async () => {
      const account = generateAccountId()
      const item = generateItemId()
      const type: ItemType = 'person'
      const modified = Date.now()

      await driver.set({ account, item, cipher: 'v1', metadata: { type, iv: 'iv-1', modified } })

      // Writing without version should be treated as create-only (attribute_not_exists) and fail
      await expect(
        driver.set({ account, item, cipher: 'overwrite-no-ver', metadata: { type, iv: 'iv-2', modified: modified + 100 } })
      ).rejects.toThrow(VersionConflictError)
    })
  })

  describe('Monotonic latestSyncCursor Progression', () => {
    it('allows initial latestSyncCursor to be set', async () => {
      const account = generateAccountId()
      await driver.createAccount({
        account,
        authToken: 'token',
        salt: 'salt',
        iterations: 1000,
        metadata: {},
      })

      await driver.updateAccountData({
        account,
        latestSyncCursor: 100,
      })

      const acct = await driver.getAccount({ account, session: 'token', isLogin: true })
      expect(acct.latestSyncCursor).toBe(100)
    })

    it('allows advancing latestSyncCursor to a higher value', async () => {
      const account = generateAccountId()
      await driver.createAccount({
        account,
        authToken: 'token',
        salt: 'salt',
        iterations: 1000,
        metadata: {},
      })

      await driver.updateAccountData({ account, latestSyncCursor: 100 })
      await driver.updateAccountData({ account, latestSyncCursor: 150 })

      const acct = await driver.getAccount({ account, session: 'token', isLogin: true })
      expect(acct.latestSyncCursor).toBe(150)
    })

    it('rejects regressing latestSyncCursor to a lower value', async () => {
      const account = generateAccountId()
      await driver.createAccount({
        account,
        authToken: 'token',
        salt: 'salt',
        iterations: 1000,
        metadata: {},
      })

      await driver.updateAccountData({ account, latestSyncCursor: 200 })

      // Attempting to set latestSyncCursor to 150 should fail conditional check
      await expect(
        driver.updateAccountData({ account, latestSyncCursor: 150 })
      ).rejects.toThrow()

      const acct = await driver.getAccount({ account, session: 'token', isLogin: true })
      expect(acct.latestSyncCursor).toBe(200)
    })
  })
})

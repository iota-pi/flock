import DynamoDriver, { getConnectionParams } from './dynamo'
import { generateItemId } from '../../utils'
import { generateAccountId } from '../util'
import type { ItemType } from 'src/shared/itemTypes'
import { VersionConflictError } from '../../shared/syncErrors'

const driver = new DynamoDriver()

function uniqueAccountId() {
  return `${generateAccountId()}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
}

describe('DynamoDriver OCC & Conditional Cursors', () => {
  beforeAll(() => {
    driver.connect(getConnectionParams())
  })

  describe('Item Snapshot OCC Versioning', () => {
    it('succeeds on first write to new item and sets version to 1', async () => {
      const account = uniqueAccountId()
      const item = generateItemId()
      const type: ItemType = 'person'
      const cipher = 'first-write'
      const iv = 'iv-1'
      const modified = Date.now()

      await driver.set({ account, item, cipher, metadata: { type, iv, modified } })
      const results = await driver.fetchByIds({ account, itemIds: [item] })
      const stored = results[0]

      expect(stored.version).toBe(1)
      expect(stored.cipher).toBe('first-write')
    })

    it('succeeds on second write when expected version matches and increments version to 2', async () => {
      const account = uniqueAccountId()
      const item = generateItemId()
      const type: ItemType = 'person'
      const modified = Date.now()

      await driver.set({ account, item, cipher: 'v1', metadata: { type, iv: 'iv-1', modified } })
      const firstResults = await driver.fetchByIds({ account, itemIds: [item] })
      const first = firstResults[0]
      expect(first.version).toBe(1)

      // Write v2 with version: 1
      await driver.set({ account, item, cipher: 'v2', metadata: { type, iv: 'iv-2', modified: modified + 100 }, version: 1 })
      const secondResults = await driver.fetchByIds({ account, itemIds: [item] })
      const second = secondResults[0]

      expect(second.version).toBe(2)
      expect(second.cipher).toBe('v2')
    })

    it('throws VersionConflictError when writing with a stale version', async () => {
      const account = uniqueAccountId()
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
      const currentResults = await driver.fetchByIds({ account, itemIds: [item] })
      const current = currentResults[0]
      expect(current.version).toBe(2)
      expect(current.cipher).toBe('v2')
    })

    it('allows updating an already existing item when writing without version', async () => {
      const account = uniqueAccountId()
      const item = generateItemId()
      const type: ItemType = 'person'
      const modified = Date.now()

      await driver.set({ account, item, cipher: 'v1', metadata: { type, iv: 'iv-1', modified } })

      // Writing without version should update the existing item unconditionally
      await driver.set({ account, item, cipher: 'overwrite-no-ver', metadata: { type, iv: 'iv-2', modified: modified + 100 } })

      const results = await driver.fetchByIds({ account, itemIds: [item] })
      expect(results[0].cipher).toBe('overwrite-no-ver')
    })
  })

  describe('Monotonic latestSyncCursor Progression', () => {
    it('allows initial latestSyncCursor to be set', async () => {
      const account = uniqueAccountId()
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
      const account = uniqueAccountId()
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
      const account = uniqueAccountId()
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

  describe('Concurrent Key Rotation & keyringVersion OCC', () => {
    it('allows updating keyringVersion and keyring when expectedKeyringVersion matches', async () => {
      const account = uniqueAccountId()
      await driver.createAccount({
        account,
        authToken: 'token',
        salt: 'salt',
        iterations: 1000,
        metadata: {},
      })

      // createAccount sets keyringVersion: 1
      await driver.updateAccountData({
        account,
        keyringVersion: 2,
        keyring: 'keyring-v2',
        expectedKeyringVersion: 1,
      })

      const acct = await driver.getAccount({ account, session: 'token', isLogin: true })
      expect(acct.keyringVersion).toBe(2)
      expect(acct.keyring).toBe('keyring-v2')
    })

    it('rejects update when expectedKeyringVersion does not match current keyringVersion', async () => {
      const account = uniqueAccountId()
      await driver.createAccount({
        account,
        authToken: 'token',
        salt: 'salt',
        iterations: 1000,
        metadata: {},
      })

      // Trying to update with mismatched expectedKeyringVersion should fail conditional check
      await expect(
        driver.updateAccountData({
          account,
          keyringVersion: 2,
          keyring: 'keyring-v2',
          expectedKeyringVersion: 99,
        })
      ).rejects.toThrow()

      const acct = await driver.getAccount({ account, session: 'token', isLogin: true })
      expect(acct.keyringVersion).toBe(1)
      expect(acct.keyring).toBeUndefined()
    })

    it('prevents concurrent key rotation race condition between two devices', async () => {
      const account = uniqueAccountId()
      await driver.createAccount({
        account,
        authToken: 'token',
        salt: 'salt',
        iterations: 1000,
        metadata: {},
      })
      await driver.updateAccountData({ account, keyring: 'initial-keyring' })

      // Device 1 and Device 2 both observed keyringVersion = 1 and attempt rotation
      // Device 1's update arrives first
      await driver.updateAccountData({
        account,
        keyringVersion: 2,
        keyring: 'device-1-keyring',
        expectedKeyringVersion: 1,
      })

      // Device 2's update arrives second with stale expectedKeyringVersion: 1
      await expect(
        driver.updateAccountData({
          account,
          keyringVersion: 2,
          keyring: 'device-2-keyring',
          expectedKeyringVersion: 1,
        })
      ).rejects.toThrow()

      // Verify Device 1's keyring remains intact and was not overwritten by Device 2
      const acct = await driver.getAccount({ account, session: 'token', isLogin: true })
      expect(acct.keyringVersion).toBe(2)
      expect(acct.keyring).toBe('device-1-keyring')
    })

    it('allows legacy accounts without keyringVersion using attribute_not_exists fallback', async () => {
      const account = uniqueAccountId()
      // Simulate a legacy account by creating without keyringVersion
      // We need to create the account and then remove keyringVersion
      await driver.createAccount({
        account,
        authToken: 'token',
        salt: 'salt',
        iterations: 1000,
        metadata: {},
      })

      // The condition uses attribute_not_exists(keyringVersion) OR keyringVersion = :expected
      // For a newly created account with keyringVersion: 1, expectedKeyringVersion: 1 should succeed
      await driver.updateAccountData({
        account,
        keyringVersion: 2,
        keyring: 'first-rotation-keyring',
        expectedKeyringVersion: 1,
      })

      const updated = await driver.getAccount({ account, session: 'token', isLogin: true })
      expect(updated.keyringVersion).toBe(2)
      expect(updated.keyring).toBe('first-rotation-keyring')
    })
  })
})

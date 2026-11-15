import { generateItemId, type SyncLogMessage } from '@vault/shared'
import DynamoDriver from './driver'
import { generateAccountId } from '../../util'

const driver = new DynamoDriver()

function message(): SyncLogMessage {
  return { itemId: generateItemId(), encryptedMessage: { iv: 'iv', cipher: 'cipher', kver: '1', format: 2 } }
}

async function addItems(account: string, count: number) {
  for (let index = 0; index < count; index += 1) {
    await driver.set({ account, item: generateItemId(), cipher: 'cipher', metadata: { iv: 'iv' } })
  }
}

describe('account deletion', () => {
  let account: string

  beforeAll(() => {
    driver.connect()
  })

  beforeEach(() => {
    account = generateAccountId(10)
  })

  it('deletes items a round at a time, reporting when none are left', async () => {
    await addItems(account, 5)
    // Deleted items go entirely, rather than staying as tombstones
    const [deleted] = await driver.fetchManifest({ account })
    await driver.set({ account, item: deleted.itemId, metadata: { iv: 'iv', deleted: true } })

    await expect(driver.deleteItems({ account, limit: 2 })).resolves.toEqual({ deleted: 2, done: false })
    await expect(driver.deleteItems({ account, limit: 2 })).resolves.toEqual({ deleted: 2, done: false })
    await expect(driver.deleteItems({ account, limit: 2 })).resolves.toMatchObject({ deleted: 1 })
    await expect(driver.deleteItems({ account, limit: 2 })).resolves.toEqual({ deleted: 0, done: true })
    await expect(driver.fetchManifest({ account })).resolves.toEqual([])
  })

  it('deletes more items than one batch write takes', async () => {
    await addItems(account, 30)

    await expect(driver.deleteItems({ account, limit: 100 })).resolves.toEqual({ deleted: 30, done: true })
    await expect(driver.fetchManifest({ account })).resolves.toEqual([])
  })

  it("leaves other accounts' items alone", async () => {
    const other = generateAccountId(10)
    await addItems(account, 1)
    await addItems(other, 2)

    await driver.deleteItems({ account, limit: 100 })

    await expect(driver.fetchManifest({ account: other })).resolves.toHaveLength(2)
  })

  it('deletes the log, head row included, so a new log would start again from 1', async () => {
    const other = generateAccountId(10)
    await driver.appendLog({ account, messages: [message(), message(), message()] })
    await driver.appendLog({ account: other, messages: [message()] })

    await expect(driver.deleteSyncLog({ account, limit: 3 })).resolves.toEqual({ deleted: 3, done: false })
    await expect(driver.deleteSyncLog({ account, limit: 3 })).resolves.toEqual({ deleted: 1, done: true })

    await expect(driver.readLogHead({ account })).resolves.toBe(0)
    await expect(driver.readLog({ account, after: 0 })).resolves.toEqual({ entries: [], hasMore: false })
    await expect(driver.readLogHead({ account: other })).resolves.toBe(1)
  })

  it('deletes the account record, and does nothing for one that is already gone', async () => {
    await driver.createAccount({ account, authToken: 'auth', salt: 'salt' })

    await driver.deleteAccount({ account })
    await expect(driver.getAccountRecord({ account })).resolves.toBeUndefined()
    await expect(driver.deleteAccount({ account })).resolves.toBeUndefined()
    // Writes to the account need its record, so nothing brings it back
    await expect(driver.addStorageUsage({ account, bytes: 1 })).resolves.toBeUndefined()
    await expect(driver.getAccountRecord({ account })).resolves.toBeUndefined()
  })
})

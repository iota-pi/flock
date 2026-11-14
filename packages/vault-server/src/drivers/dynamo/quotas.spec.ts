import { DeleteTableCommand, DescribeTableCommand } from '@aws-sdk/client-dynamodb'
import { generateItemId, type SyncLogMessage } from '@vault/shared'
import DynamoDriver from './driver'
import { QuotaExceededError } from '../../errors'
import { generateAccountId } from '../../util'

const driver = new DynamoDriver()

async function createAccount() {
  const account = generateAccountId(10)
  await driver.createAccount({ account, authToken: 'token', salt: 'salt', iterations: 1000 })
  return account
}

/** Writes an item the way persistSnapshots does, adding what it grew by to the account's usage */
async function write(account: string, item: string, cipher: string | undefined, deleted = false) {
  const result = await driver.set({
    account,
    item,
    metadata: { iv: '', modified: Date.now(), ...(deleted ? { deleted: true } : {}) },
    ...(cipher === undefined ? {} : { snapshot: { iv: 'iv', cipher, kver: '1', format: 2 as const } }),
  })
  await driver.addStorageUsage({ account, bytes: result.storageDelta })
  return result
}

async function storageBytes(account: string) {
  return (await driver.getAccountRecord({ account }))?.storageBytes
}

describe('storage usage', () => {
  beforeAll(() => {
    driver.connect()
  })

  it('reports how much each write grew or shrank the item, with its version', async () => {
    const account = await createAccount()
    const item = generateItemId()
    const small = Buffer.alloc(100).toString('base64')
    const large = Buffer.alloc(1000).toString('base64')

    const created = await write(account, item, small)
    const grown = await write(account, item, large)
    const shrunk = await write(account, item, small)

    expect(created.version).toBe(1)
    expect(grown.version).toBe(2)
    expect(shrunk.version).toBe(3)
    expect(created.storageDelta).toBeGreaterThan(100)
    // Snapshots are stored as binary, so a 900-byte larger payload adds 900 bytes
    expect(grown.storageDelta).toBe(900)
    expect(shrunk.storageDelta).toBe(-900)
  })

  // Usage kept up by writes must agree with a count of the items, or the quota drifts
  it('keeps the same count that a recount makes from the items', async () => {
    const account = await createAccount()
    const [first, second] = [generateItemId(), generateItemId()]

    await write(account, first, Buffer.alloc(500).toString('base64'))
    await write(account, second, Buffer.alloc(2000).toString('base64'))
    await write(account, first, Buffer.alloc(50).toString('base64'))
    // A payload-less tombstone keeps the previous snapshot
    await write(account, second, undefined, true)
    const kept = await storageBytes(account)

    await expect(driver.recountStorageUsage({ account })).resolves.toBe(kept)
    expect(await storageBytes(account)).toBe(kept)
    expect((await driver.getAccountRecord({ account }))?.storageCountedAt).toEqual(expect.any(Number))
  })

  it('adds nothing to an account that does not exist', async () => {
    const account = generateAccountId(10)

    await driver.addStorageUsage({ account, bytes: 10 })

    await expect(driver.getAccountRecord({ account })).resolves.toBeUndefined()
  })
})

describe('log quota', () => {
  let account: string

  beforeAll(() => {
    driver.connect()
  })

  beforeEach(() => {
    account = generateAccountId(10)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  function message(bytes: number): SyncLogMessage {
    return { itemId: generateItemId(), encryptedMessage: { iv: 'iv', cipher: 'c'.repeat(bytes), kver: '1', format: 2 } }
  }

  /** A message's size as the quota counts it */
  const sizeOf = (m: SyncLogMessage) => Buffer.byteLength(JSON.stringify(m))

  it('appends up to the day\'s quota and refuses a push that would pass it, appending nothing', async () => {
    const first = message(500)
    const second = message(500)
    const maxBytesPerDay = sizeOf(first) + sizeOf(second)

    await driver.appendLog({ account, messages: [first], maxBytesPerDay })
    await driver.appendLog({ account, messages: [second], maxBytesPerDay })
    await expect(driver.appendLog({ account, messages: [message(1)], maxBytesPerDay }))
      .rejects.toBeInstanceOf(QuotaExceededError)

    await expect(driver.readLogHead({ account })).resolves.toBe(2)
  })

  it('starts each UTC day afresh', async () => {
    const first = message(500)
    const maxBytesPerDay = sizeOf(first)
    const today = Date.UTC(2026, 10, 14, 23, 59)
    vi.spyOn(Date, 'now').mockReturnValue(today)
    await driver.appendLog({ account, messages: [first], maxBytesPerDay })
    await expect(driver.appendLog({ account, messages: [message(500)], maxBytesPerDay }))
      .rejects.toBeInstanceOf(QuotaExceededError)

    vi.spyOn(Date, 'now').mockReturnValue(today + 2 * 60 * 1000)
    await driver.appendLog({ account, messages: [message(500)], maxBytesPerDay })

    await expect(driver.readLogHead({ account })).resolves.toBe(2)
  })
})

describe('updateAccountData remove', () => {
  beforeAll(() => {
    driver.connect()
  })

  it('deletes the given fields and sets the others', async () => {
    const account = await createAccount()
    await driver.updateAccountData<{ reminderIndex: string }>({ account, reminderIndex: 'on' })

    await driver.updateAccountData({ account, keyringVersion: 3, remove: ['reminderIndex'] })

    const record = await driver.getAccountRecord({ account }) as Record<string, unknown>
    expect(record).not.toHaveProperty('reminderIndex')
    expect(record.keyringVersion).toBe(3)
  })
})

describe('init with account indexes', () => {
  const suffix = generateAccountId(8)
  const tables = {
    accounts: `IndexTestAccounts-${suffix}`,
    items: `IndexTestItems-${suffix}`,
    syncLog: `IndexTestSyncLog-${suffix}`,
    loginThrottle: `IndexTestLoginThrottle-${suffix}`,
  }
  const index = { name: 'ReminderIndex', partitionKey: 'reminderIndex', attributes: ['reminderTime'] }

  afterAll(async () => {
    const cleanup = new DynamoDriver({ tables }).connect()
    for (const TableName of Object.values(tables)) {
      await cleanup.client.send(new DeleteTableCommand({ TableName })).catch(() => undefined)
    }
  })

  it('adds an index to an accounts table that was created without it', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    await new DynamoDriver({ tables }).connect().init()
    const indexed = new DynamoDriver({ tables, accountIndexes: [index] }).connect()

    await indexed.init()
    // A second run finds the index and leaves it alone
    await indexed.init()

    const { Table } = await indexed.client.send(new DescribeTableCommand({ TableName: tables.accounts }))
    expect(Table?.GlobalSecondaryIndexes?.map(gsi => gsi.IndexName)).toEqual(['ReminderIndex'])
    expect(Table?.GlobalSecondaryIndexes?.[0].Projection).toEqual({
      ProjectionType: 'INCLUDE',
      NonKeyAttributes: ['reminderTime'],
    })
  })
})

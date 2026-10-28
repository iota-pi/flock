import { randomUUID } from 'node:crypto'
import { DeleteTableCommand } from '@aws-sdk/client-dynamodb'
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb'
import DynamoDriver from '@vault/server/dynamo'
import { generateItemId } from '@vault/shared'
import { dropDeletedItemPayloads } from './deletedItemPayloads'

// The migration scans a whole table, so it runs against tables of its own rather than the ones
// other test files share. Always DynamoDB Local (`yarn initdb`'s endpoint), never AWS.
const suffix = randomUUID().slice(0, 8)
const tables = {
  accounts: `DeletedPayloadsTestAccounts_${suffix}`,
  items: `DeletedPayloadsTestItems_${suffix}`,
  syncMessages: `DeletedPayloadsTestSyncMessages_${suffix}`,
}
const driver = new DynamoDriver({ tables }).connect({
  endpoint: process.env.DYNAMODB_ENDPOINT ?? 'http://127.0.0.1:8000',
  region: 'local',
  credentials: { accessKeyId: 'foo', secretAccessKey: 'bar' },
})

const account = 'acct-deleted-payloads'
const modified = 1_700_000_000_000
const snapshot = { iv: 'snap-iv', cipher: 'c25hcHNob3Q=', kver: '1', format: 2 as const }

async function readRow(item: string) {
  const response = await driver.client.send(new GetCommand({ TableName: tables.items, Key: { account, item } }))
  return response.Item
}

describe('dropDeletedItemPayloads', () => {
  // Often the worker's first DynamoDB request, which opens the connection, and then three
  // `CreateTable`s: about 0.1s alone, but 1-5s and once over 10s while other suites load the machine
  beforeAll(async () => {
    await driver.init()
  }, 30_000)

  afterAll(async () => {
    for (const table of Object.values(tables)) {
      await driver.client.send(new DeleteTableCommand({ TableName: table })).catch(() => undefined)
    }
  })

  it('strips deleted items\' content and keeps what the manifest reads', async () => {
    const deleted = generateItemId()
    await driver.set({ account, item: deleted, metadata: { iv: '', modified }, snapshot })
    await driver.set({ account, item: deleted, metadata: { iv: '', modified: modified + 1, deleted: true }, snapshot })
    const active = generateItemId()
    await driver.set({ account, item: active, metadata: { iv: '', modified }, snapshot })
    const legacyDeleted = generateItemId()
    await driver.set({ account, item: legacyDeleted, cipher: 'legacy', metadata: { iv: 'iv-1', modified, deleted: true } })
    // Rows from before `metadata.deleted` mark deletion at the top level
    const topLevelDeleted = generateItemId()
    await driver.client.send(new PutCommand({
      TableName: tables.items,
      Item: { account, item: topLevelDeleted, deleted: true, cipher: 'old', metadata: { iv: 'iv-2', modified }, version: 3 },
    }))
    const manifestBefore = await driver.fetchManifest({ account })

    await expect(dropDeletedItemPayloads(driver.client, tables.items, { dryRun: true }))
      .resolves.toEqual({ found: 3, dropped: 0 })
    expect((await readRow(deleted))?.snapshot).toBeDefined()

    await expect(dropDeletedItemPayloads(driver.client, tables.items)).resolves.toEqual({ found: 3, dropped: 3 })

    for (const item of [deleted, legacyDeleted, topLevelDeleted]) {
      const row = await readRow(item)
      expect(row).toBeDefined()
      expect(row).not.toHaveProperty('snapshot')
      expect(row).not.toHaveProperty('cipher')
    }
    expect(await readRow(deleted)).toMatchObject({ version: 2, metadata: { deleted: true, modified: modified + 1 } })
    expect(await readRow(topLevelDeleted)).toMatchObject({ version: 3, deleted: true })
    expect((await readRow(active))?.snapshot).toBeDefined()
    // Devices see exactly what they saw before, so none re-fetches or re-uploads anything
    expect(await driver.fetchManifest({ account })).toEqual(manifestBefore)

    // A later run finds nothing left, so a run the Lambda cut short can simply be started again
    await expect(dropDeletedItemPayloads(driver.client, tables.items)).resolves.toEqual({ found: 0, dropped: 0 })
  })
})

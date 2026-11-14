import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  DynamoDBDocumentClient,
  ScanCommand,
  type ScanCommandInput,
  type ScanCommandOutput,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb'

import { DEFAULT_ACCOUNT_QUOTAS, type VaultAccount } from '@vault/server'
import { getConnectionParams } from '@vault/server/dynamo'
import { flockDataVersionPolicy } from '../flockDataVersion'
import { createFlockDriver, FLOCK_TABLES, REMINDER_INDEX, REMINDERS_ON } from '../flockDriver'
import { dropDeletedItemPayloads } from './deletedItemPayloads'

const ddb = new DynamoDBClient(getConnectionParams())
const client = DynamoDBDocumentClient.from(ddb)

/** Scans the accounts table to the end, yielding the records of each page as it arrives */
async function* scanAccounts(input: Omit<ScanCommandInput, 'TableName' | 'ExclusiveStartKey'>) {
  let lastEvaluatedKey: ScanCommandOutput['LastEvaluatedKey'] | undefined
  do {
    const response = await client.send(new ScanCommand({
      ...input,
      TableName: FLOCK_TABLES.accounts,
      ExclusiveStartKey: lastEvaluatedKey,
    }))
    yield* response.Items ?? []
    lastEvaluatedKey = response.LastEvaluatedKey
  } while (lastEvaluatedKey)
}

function isConditionalCheckFailure(error: unknown) {
  return (error as { name?: unknown })?.name === 'ConditionalCheckFailedException'
}

const migrations: { [name: string]: () => Promise<void> } = {
  async removeItemTypeMetadata () {
    // Clients no longer send the plaintext item type, so strip it from rows written before that
    let lastEvaluatedKey: ScanCommandOutput['LastEvaluatedKey'] | undefined
    let updated = 0
    do {
      const response = await client.send(new ScanCommand({
        TableName: FLOCK_TABLES.items,
        ProjectionExpression: '#account, #item, #metadata.#type',
        ExpressionAttributeNames: {
          '#account': 'account',
          '#item': 'item',
          '#metadata': 'metadata',
          '#type': 'type',
        },
        ExclusiveStartKey: lastEvaluatedKey,
      }))

      for (const item of response?.Items || []) {
        if (item.metadata?.type !== undefined) {
          await client.send(new UpdateCommand({
            TableName: FLOCK_TABLES.items,
            Key: { account: item.account, item: item.item },
            UpdateExpression: 'REMOVE #metadata.#type',
            ConditionExpression: 'attribute_exists(#metadata)',
            ExpressionAttributeNames: {
              '#metadata': 'metadata',
              '#type': 'type',
            },
          }))
          updated += 1
        }
      }
      lastEvaluatedKey = response?.LastEvaluatedKey
    } while (lastEvaluatedKey)
    console.info(`Removed plaintext type from ${updated} items`)
  },
  async removeLegacyAccountMetadata () {
    // Clients copy the plaintext settings into their encrypted settings document and then clear them.
    // Run this only after the deprecation window: an account that has not migrated yet loses the
    // server's copy and falls back to the settings stored on its devices.
    let lastEvaluatedKey: ScanCommandOutput['LastEvaluatedKey'] | undefined
    let updated = 0
    do {
      const response = await client.send(new ScanCommand({
        TableName: FLOCK_TABLES.accounts,
        ProjectionExpression: '#account, #metadata',
        FilterExpression: 'attribute_exists(#metadata)',
        ExpressionAttributeNames: {
          '#account': 'account',
          '#metadata': 'metadata',
        },
        ExclusiveStartKey: lastEvaluatedKey,
      }))

      for (const item of response?.Items || []) {
        await client.send(new UpdateCommand({
          TableName: FLOCK_TABLES.accounts,
          Key: { account: item.account },
          UpdateExpression: 'REMOVE #metadata',
          ExpressionAttributeNames: {
            '#metadata': 'metadata',
          },
        }))
        updated += 1
      }
      lastEvaluatedKey = response?.LastEvaluatedKey
    } while (lastEvaluatedKey)
    console.info(`Removed legacy plaintext metadata from ${updated} accounts`)
  },
  async countDeletedItemPayloads () {
    // Read-only: how many deleted items dropDeletedItemPayloads would strip
    const { found } = await dropDeletedItemPayloads(client, FLOCK_TABLES.items, { dryRun: true })
    console.info(`${found} deleted items still hold a snapshot payload or legacy cipher`)
  },
  async dropDeletedItemPayloads () {
    // Destructive: removes deleted items' content, keeping their metadata and version. Run
    // countDeletedItemPayloads first. Safe to run again if the Lambda times out.
    const { dropped } = await dropDeletedItemPayloads(client, FLOCK_TABLES.items)
    console.info(`Dropped the payloads of ${dropped} deleted items`)
  },
  async indexReminderAccounts () {
    // Puts every account with reminders on in the notifier's index (REMINDER_INDEX), which only
    // updateReminderSettings maintains. Run it as soon as the index exists: the notifier reads only
    // the index, so until then accounts that turned reminders on before it get none. Safe to run again.
    let indexed = 0
    for await (const { account } of scanAccounts({
      FilterExpression: 'reminderEnabled = :true AND attribute_not_exists(#index)',
      ExpressionAttributeNames: { '#index': REMINDER_INDEX.partitionKey },
      ExpressionAttributeValues: { ':true': true },
      ProjectionExpression: 'account',
    })) {
      try {
        await client.send(new UpdateCommand({
          TableName: FLOCK_TABLES.accounts,
          Key: { account },
          UpdateExpression: 'SET #index = :on',
          // Unless the user turned reminders off since the scan read the account
          ConditionExpression: 'reminderEnabled = :true',
          ExpressionAttributeNames: { '#index': REMINDER_INDEX.partitionKey },
          ExpressionAttributeValues: { ':on': REMINDERS_ON, ':true': true },
        }))
        indexed += 1
      } catch (error) {
        if (!isConditionalCheckFailure(error)) throw error
      }
    }
    console.info(`Added ${indexed} accounts to ${REMINDER_INDEX.name}`)
  },
  async recountStorageUsage () {
    // Counts each account's storage from its items, for the storage quota. Accounts from before the
    // quota have no count, and count as using nothing until this runs. It reads every item, so it may
    // time out: run it again until it reports none left. Then run reportStorageUsage.
    const vault = createFlockDriver()
    let counted = 0
    for await (const { account } of scanAccounts({
      FilterExpression: 'attribute_not_exists(storageCountedAt)',
      ProjectionExpression: 'account',
    })) {
      await vault.recountStorageUsage({ account })
      counted += 1
    }
    console.info(`Counted the storage of ${counted} accounts, and none are left`)
  },
  async reportStorageUsage () {
    // Read-only: how much the accounts store, against the storage quota
    const usages: number[] = []
    let uncounted = 0
    for await (const record of scanAccounts({ ProjectionExpression: 'storageBytes, storageCountedAt' })) {
      if (record.storageCountedAt === undefined) uncounted += 1
      usages.push(typeof record.storageBytes === 'number' ? record.storageBytes : 0)
    }
    usages.sort((a, b) => a - b)
    const at = (fraction: number) => usages[Math.min(usages.length - 1, Math.floor(fraction * usages.length))] ?? 0
    const megabytes = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(2)} MiB`
    const quota = DEFAULT_ACCOUNT_QUOTAS.storageBytes
    console.info(`${usages.length} accounts, ${uncounted} not yet counted by recountStorageUsage`)
    console.info(`Median ${megabytes(at(0.5))}, 99th percentile ${megabytes(at(0.99))}, largest ${megabytes(at(1))}`)
    console.info(`${usages.filter(bytes => bytes >= quota).length} accounts at or over the quota of ${megabytes(quota)}`)
  },
  async countAccountsByDataVersion () {
    // Read-only report of how far each account's stored data has been migrated (see "Backwards
    // compatibility" in docs/vault-extraction.md) and what holds back the accounts below the
    // current version. Their clients raise the version once nothing is left.
    const vault = createFlockDriver()
    const accountsByVersion = new Map<number, number>()
    const accountsByBlocker = new Map<string, number>()
    let readyToRaise = 0
    // getSecurityParams falls back to the account ID for these, until none are left
    let withoutSalt = 0
    let oldestAccessBelowCurrent = Infinity
    let lastEvaluatedKey: ScanCommandOutput['LastEvaluatedKey'] | undefined
    do {
      const response = await client.send(new ScanCommand({
        TableName: FLOCK_TABLES.accounts,
        ExclusiveStartKey: lastEvaluatedKey,
      }))

      for (const accountData of (response?.Items || []) as VaultAccount[]) {
        if (typeof accountData.salt !== 'string') {
          withoutSalt += 1
        }
        const dataVersion = accountData.dataVersion ?? 0
        accountsByVersion.set(dataVersion, (accountsByVersion.get(dataVersion) ?? 0) + 1)
        if (dataVersion >= flockDataVersionPolicy.current) continue

        oldestAccessBelowCurrent = Math.min(oldestAccessBelowCurrent, accountData.lastAccess ?? 0)
        const { blockers } = await flockDataVersionPolicy.findBlockers({ account: accountData.account, accountData, vault })
        if (blockers.length === 0) {
          readyToRaise += 1
        }
        for (const blocker of blockers) {
          accountsByBlocker.set(blocker, (accountsByBlocker.get(blocker) ?? 0) + 1)
        }
      }
      lastEvaluatedKey = response?.LastEvaluatedKey
    } while (lastEvaluatedKey)

    console.info('Accounts by data version:', Object.fromEntries(accountsByVersion))
    console.info('Accounts below the current version, by what they still need:', Object.fromEntries(accountsByBlocker))
    console.info(`${readyToRaise} accounts below the current version have nothing left to migrate`)
    console.info(`${withoutSalt} accounts have no stored salt`)
    if (Number.isFinite(oldestAccessBelowCurrent)) {
      const lastAccess = oldestAccessBelowCurrent > 0 ? new Date(oldestAccessBelowCurrent).toISOString() : 'never recorded'
      console.info(`Oldest last access below the current version: ${lastAccess}`)
    }
  },
}

export const handler = async (event: { migrationName: string }) => {
  const { migrationName } = event
  // Own properties only, so a name such as `constructor` doesn't reach Object.prototype
  if (!Object.hasOwn(migrations, migrationName)) {
    throw new Error(`Unknown migration ${migrationName}`)
  }
  await migrations[migrationName]()
}

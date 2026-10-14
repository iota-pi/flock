import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, ScanCommand, ScanCommandOutput, UpdateCommand } from '@aws-sdk/lib-dynamodb'

import { createHash } from 'crypto'
import { VaultItem } from '../drivers/base'
import { getConnectionParams } from '../drivers/dynamo'
import { FLOCK_TABLES } from '../flockDriver'

const ddb = new DynamoDBClient(getConnectionParams())
const client = DynamoDBDocumentClient.from(ddb)

const migrations: { [name: string]: () => Promise<void> } = {
  async backupAuthToken () {
    const results = await client.send(new ScanCommand({
      TableName: FLOCK_TABLES.accounts,
      AttributesToGet: ['account', 'authToken'],
    }))
    const items = results.Items as { account: string, authToken: string }[] | undefined
    if (items) {
      for (const { account, authToken } of items) {
        await client.send(new UpdateCommand({
          TableName: FLOCK_TABLES.accounts,
          Key: { account },
          UpdateExpression: 'SET rawAuthToken = :token',
          ExpressionAttributeValues: {
            ':token': authToken,
          },
        }))
      }
      console.info(`Updated ${items.length} items`)
    }
  },
  async hashAuthToken () {
    const results = await client.send(new ScanCommand({
      TableName: FLOCK_TABLES.accounts,
      AttributesToGet: ['account', 'authToken'],
    }))
    const items = results.Items as { account: string, authToken: string }[] | undefined
    if (items) {
      for (const { account, authToken } of items) {
        const hash = createHash('sha512')
        hash.update(Buffer.from(authToken, 'utf8'))
        await client.send(new UpdateCommand({
          TableName: FLOCK_TABLES.accounts,
          Key: { account },
          UpdateExpression: 'SET hashAuthToken = :token',
          ExpressionAttributeValues: {
            ':token': hash.digest().toString('base64'),
          },
        }))
      }
      console.info(`Updated ${items.length} items`)
    }
  },
  async installHashAuthToken () {
    const results = await client.send(new ScanCommand({
      TableName: FLOCK_TABLES.accounts,
      AttributesToGet: ['account'],
    }))
    const items = results.Items as { account: string, authToken: string }[] | undefined
    if (items) {
      for (const { account } of items) {
        await client.send(new UpdateCommand({
          TableName: FLOCK_TABLES.accounts,
          Key: { account },
          UpdateExpression: 'SET authToken = hashAuthToken',
        }))
      }
      console.info(`Updated ${items.length} items`)
    }
  },
  async cleanUpAuthToken () {
    const results = await client.send(new ScanCommand({
      TableName: FLOCK_TABLES.accounts,
      AttributesToGet: ['account'],
    }))
    const items = results.Items as { account: string }[] | undefined
    if (items) {
      for (const { account } of items) {
        await client.send(new UpdateCommand({
          TableName: FLOCK_TABLES.accounts,
          Key: { account },
          UpdateExpression: 'REMOVE rawAuthToken, hashAuthToken',
        }))
      }
      console.info(`Updated ${items.length} items`)
    }
  },
  async addModifiedTime () {
    const maxItems = 10000
    const items: VaultItem[] = []
    let lastEvaluatedKey: ScanCommandOutput['LastEvaluatedKey'] | undefined
    while (items.length < maxItems) {
      const response = await client.send(new ScanCommand({ TableName: FLOCK_TABLES.items }))
      if (response?.Items) {
        items.push(...response?.Items as VaultItem[])
      }
      lastEvaluatedKey = response?.LastEvaluatedKey
      if (!lastEvaluatedKey) {
        break
      }
    }
    const now = new Date().getTime()
    let updated = 0
    for (const item of items) {
      if (!item.metadata.modified) {
        await client.send(new UpdateCommand({
          TableName: FLOCK_TABLES.items,
          Key: { account: item.account, item: item.item },
          UpdateExpression: 'SET metadata.modified = :modified',
          ExpressionAttributeValues: {
            ':modified': now,
          },
        }))
        updated += 1
      }
    }
    console.info(`Updated ${updated} items`)
  },
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
  async countUnboundSnapshots () {
    // Read-only report. Clients rewrite their snapshots bound to the document once they update;
    // unbound ciphertexts can only be rejected once this reaches zero (sync messages expire on their own).
    let lastEvaluatedKey: ScanCommandOutput['LastEvaluatedKey'] | undefined
    let unbound = 0
    const accounts = new Set<string>()
    do {
      const response = await client.send(new ScanCommand({
        TableName: FLOCK_TABLES.items,
        ProjectionExpression: '#account',
        FilterExpression: 'attribute_exists(#snapshot.#cipher) AND attribute_not_exists(#snapshot.#format)',
        ExpressionAttributeNames: {
          '#account': 'account',
          '#snapshot': 'snapshot',
          '#cipher': 'cipher',
          '#format': 'format',
        },
        ExclusiveStartKey: lastEvaluatedKey,
      }))

      for (const item of response?.Items || []) {
        unbound += 1
        accounts.add(item.account)
      }
      lastEvaluatedKey = response?.LastEvaluatedKey
    } while (lastEvaluatedKey)
    console.info(`${unbound} snapshots across ${accounts.size} accounts are not bound to their document`)
  },
  async backfillSyncMessageAccounts () {
    let lastEvaluatedKey: ScanCommandOutput['LastEvaluatedKey'] | undefined
    let updated = 0
    do {
      const response = await client.send(new ScanCommand({
        TableName: FLOCK_TABLES.syncMessages,
        ExclusiveStartKey: lastEvaluatedKey,
      }))
      
      const items = response?.Items || []
      
      for (const item of items) {
        if (!item.account && item.syncId) {
          const accountId = item.syncId.split('#')[0]
          if (accountId) {
            await client.send(new UpdateCommand({
              TableName: FLOCK_TABLES.syncMessages,
              Key: { syncId: item.syncId, cursor: item.cursor },
              UpdateExpression: 'SET account = :account',
              ExpressionAttributeValues: {
                ':account': accountId,
              },
            }))
            updated += 1
          }
        }
      }
      lastEvaluatedKey = response?.LastEvaluatedKey
    } while (lastEvaluatedKey)
    console.info(`Backfilled account attribute for ${updated} sync messages`)
  },
}

export const handler = async (event: { migrationName: string }) => {
  const { migrationName } = event
  const migration = migrations[migrationName]
  if (migration === undefined) {
    throw new Error(`Unknown migration ${migrationName}`)
  }
  await migration()
}

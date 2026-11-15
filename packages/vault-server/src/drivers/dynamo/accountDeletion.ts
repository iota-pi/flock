import { BatchWriteCommand, DeleteCommand, QueryCommand, type BatchWriteCommandInput } from '@aws-sdk/lib-dynamodb'
import type { BaseData, DeleteBatchResult } from '../vaultDriver'
import { sendBatchWithRetry } from './batchRetry'
import { partitionKeyCondition, projection } from './expressions'
import type { DynamoContext } from './commands'

// The most requests one BatchWriteItem takes
const BATCH_WRITE_SIZE = 25

/**
 * Deletes up to `limit` of an account's rows from a table keyed by `account` and `sortKey`, and reports
 * whether that was all of them. It reads the first page afresh each time, since the rows it deleted
 * last time are gone.
 */
async function deleteAccountRows(
  { client }: DynamoContext,
  { table, sortKey, account, limit }: { table: string, sortKey: string, account: string, limit: number },
): Promise<DeleteBatchResult> {
  const response = await client.send(new QueryCommand({
    TableName: table,
    ...partitionKeyCondition('account', account),
    ...projection(['account', sortKey]),
    Limit: limit,
    ConsistentRead: true,
  }))
  const keys = (response.Items ?? []).map(row => ({ account, [sortKey]: row[sortKey] as unknown }))

  const batches: (typeof keys)[] = []
  for (let start = 0; start < keys.length; start += BATCH_WRITE_SIZE) {
    batches.push(keys.slice(start, start + BATCH_WRITE_SIZE))
  }
  await Promise.all(batches.map(batch => sendBatchWithRetry<BatchWriteCommandInput['RequestItems']>({
    request: { [table]: batch.map(Key => ({ DeleteRequest: { Key } })) },
    commandName: 'BatchWriteCommand',
    unprocessedName: 'items',
    send: async request => {
      const result = await client.send(new BatchWriteCommand({ RequestItems: request }))
      return result.UnprocessedItems
    },
  })))

  return { deleted: keys.length, done: response.LastEvaluatedKey === undefined }
}

export function deleteItems(context: DynamoContext, { account, limit }: BaseData & { limit: number }) {
  return deleteAccountRows(context, { table: context.tables.items, sortKey: 'item', account, limit })
}

export function deleteSyncLog(context: DynamoContext, { account, limit }: BaseData & { limit: number }) {
  return deleteAccountRows(context, { table: context.tables.syncLog, sortKey: 'seq', account, limit })
}

export async function deleteAccount({ client, tables }: DynamoContext, { account }: BaseData): Promise<void> {
  await client.send(new DeleteCommand({ TableName: tables.accounts, Key: { account } }))
}

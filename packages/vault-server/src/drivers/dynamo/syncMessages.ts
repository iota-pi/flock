import {
  BatchWriteCommand,
  BatchWriteCommandInput,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb'
import { chunk } from 'lodash-es'
import type { ItemId, PageToken } from '@vault/shared'
import type {
  GetGlobalSyncMessagesInput,
  GetSyncMessagesInput,
  GlobalSyncMessagesPage,
  PushSyncMessagesInput,
  StoredSyncMessage,
  SyncMessagesPage,
  ValidatePageTokenInput,
} from '../vaultDriver'
import { ACCOUNT_CURSOR_INDEX } from './tables'
import { cursorKeyCondition } from './expressions'
import { sendBatchWithRetry } from './batchRetry'
import { decodeGlobalPageToken, decodeItemPageToken, encodePageToken } from './pageTokens'
import { parseSyncId, toSyncId } from './syncIds'
import type { DynamoContext } from './commands'

const SYNC_MESSAGE_TTL = 90 * 24 * 60 * 60
const PUSH_BATCH_SIZE = 25
export const SYNC_MESSAGE_PAGE_SIZE = 200

export async function pushSyncMessagesBatch(
  { client, tables }: DynamoContext,
  input: PushSyncMessagesInput,
): Promise<void> {
  const batches = chunk(input.messages, PUSH_BATCH_SIZE)

  await Promise.all(
    batches.map(batch => sendBatchWithRetry<BatchWriteCommandInput['RequestItems']>({
      request: {
        [tables.syncMessages]: batch.map(message => ({
          PutRequest: {
            Item: {
              syncId: toSyncId(input.account, message.itemId),
              cursor: message.entry.cursor,
              account: input.account,
              encryptedMessage: message.entry.encryptedMessage,
              createdAt: message.entry.createdAt,
              expiresAt: Math.floor(Date.now() / 1000) + SYNC_MESSAGE_TTL,
            },
          },
        })),
      },
      commandName: 'BatchWriteCommand',
      unprocessedName: 'items',
      send: async request => {
        const response = await client.send(new BatchWriteCommand({ RequestItems: request }))
        return response.UnprocessedItems
      },
    })),
  )
}

/** A sync messages table record, as far as the driver reads it */
type SyncMessageRow = StoredSyncMessage & { syncId: string }

/** The message clients read, without the record's keys and TTL */
function toStoredSyncMessage({ cursor, encryptedMessage, createdAt }: SyncMessageRow): StoredSyncMessage {
  return { cursor, encryptedMessage, createdAt }
}

export async function getSyncMessages(context: DynamoContext, input: GetSyncMessagesInput): Promise<SyncMessagesPage> {
  const expectedSyncId = toSyncId(input.account, input.itemId)
  const { items, hasMore, nextPageToken } = await querySyncMessagePage(context, {
    partitionKey: 'syncId',
    partitionValue: expectedSyncId,
    afterCursor: input.fromCursor,
    startKey: input.pageToken
      ? decodeItemPageToken(input.pageToken, expectedSyncId, input.fromCursor)
      : undefined,
  })
  return { messages: items.map(toStoredSyncMessage), hasMore, nextPageToken }
}

export function validatePageToken(input: ValidatePageTokenInput): void {
  if (input.itemId) {
    decodeItemPageToken(input.pageToken, toSyncId(input.account, input.itemId), input.cursor)
  } else {
    decodeGlobalPageToken(input.pageToken, input.account)
  }
}

export async function getGlobalSyncMessagesAfterCursor(
  context: DynamoContext,
  input: GetGlobalSyncMessagesInput,
): Promise<GlobalSyncMessagesPage> {
  const messagesByItem = new Map<ItemId, StoredSyncMessage[]>()

  const startKey = input.pageToken
    ? decodeGlobalPageToken(input.pageToken, input.account)
    : undefined
  const { items, hasMore, nextPageToken } = await querySyncMessagePage(context, {
    indexName: ACCOUNT_CURSOR_INDEX,
    partitionKey: 'account',
    partitionValue: input.account,
    afterCursor: input.cursor,
    startKey,
  })

  // Highest cursor examined by this page (before any caller-side filtering), so clients can
  // track the global scan position independently of per-item cursors.
  let scannedThroughCursor = startKey?.cursor ?? input.cursor ?? 0

  for (const item of items) {
    if (typeof item.cursor === 'number' && item.cursor > scannedThroughCursor) {
      scannedThroughCursor = item.cursor
    }
    const itemId = parseSyncId(item.syncId)?.itemId
    if (!itemId) continue

    let messages = messagesByItem.get(itemId)
    if (!messages) {
      messages = []
      messagesByItem.set(itemId, messages)
    }
    messages.push(toStoredSyncMessage(item))
  }

  // The query returns messages in ascending cursor order (the index's range key) and grouping keeps
  // that order, so each item's messages are already sorted by cursor
  return {
    items: Array.from(messagesByItem.entries()).map(([itemId, messages]) => ({ itemId, messages })),
    hasMore,
    nextPageToken,
    scannedThroughCursor,
  }
}

/**
 * Queries one page of a partition's sync messages: from the decoded page token when there is one,
 * otherwise after `afterCursor`
 */
async function querySyncMessagePage(
  { client, tables, syncMessagePageSize }: DynamoContext,
  {
    indexName,
    partitionKey,
    partitionValue,
    afterCursor,
    startKey,
  }: {
    indexName?: string
    partitionKey: string
    partitionValue: string
    afterCursor: number | undefined
    startKey: Record<string, unknown> | undefined
  },
): Promise<{ items: SyncMessageRow[], hasMore: boolean, nextPageToken?: PageToken }> {
  const response = await client.send(new QueryCommand({
    TableName: tables.syncMessages,
    IndexName: indexName,
    // A continuation starts from the token, which already lies after the cursor
    ...cursorKeyCondition(partitionKey, partitionValue, startKey ? undefined : afterCursor),
    Limit: syncMessagePageSize,
    ExclusiveStartKey: startKey,
  }))
  return {
    items: (response.Items ?? []) as SyncMessageRow[],
    hasMore: !!response.LastEvaluatedKey,
    nextPageToken: response.LastEvaluatedKey ? encodePageToken(response.LastEvaluatedKey) : undefined,
  }
}

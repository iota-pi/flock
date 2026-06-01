import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  BatchWriteCommand,
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb'
import { chunk } from 'lodash-es'
import type { AutomergeSyncConfig } from './automergeSyncConfig'

const SYNC_MESSAGE_TTL = 7 * 24 * 60 * 60
const DEFAULT_SYNC_MESSAGE_LIMIT = 200

export type StoredSyncMessage = {
  cursor: number
  encryptedMessage: {
    iv: string
    cipher: string
    version?: string
  }
  createdAt: number
}

type AppendSyncMessageInput = {
  account: string
  itemId: string
  entry: StoredSyncMessage
  lastModified: number
}

type PushSyncMessagesBatchInput = {
  account: string
  messages: Array<Omit<AppendSyncMessageInput, 'account'>>
}

export interface AutomergeSyncRepository {
  appendSyncMessage(input: AppendSyncMessageInput): Promise<void>
  pushSyncMessagesBatch(input: PushSyncMessagesBatchInput): Promise<void>
  getSyncMessages(input: {
    account: string
    itemId: string
    fromCursor?: number
    limit?: number
  }): Promise<{ messages: StoredSyncMessage[]; hasMore: boolean }>
  pruneSyncMessagesUpToCursor(input: { account: string; itemId: string; cursor: number }): Promise<number>
}

const PUSH_BATCH_SIZE = 25

export function createDynamoAutomergeSyncRepository(config: AutomergeSyncConfig): AutomergeSyncRepository {
  const ddbClient = new DynamoDBClient({ region: config.awsRegion })
  const docClient = DynamoDBDocumentClient.from(ddbClient, {
    marshallOptions: {
      removeUndefinedValues: true,
    },
  })

  return {
    async appendSyncMessage(input: AppendSyncMessageInput): Promise<void> {
      await docClient.send(new PutCommand({
        TableName: config.syncMessagesTable,
        Item: {
          syncId: `${input.account}#${input.itemId}`,
          cursor: input.entry.cursor,
          encryptedMessage: input.entry.encryptedMessage,
          createdAt: input.entry.createdAt,
          expiresAt: Math.floor(Date.now() / 1000) + SYNC_MESSAGE_TTL,
        },
      }))
    },

    async pushSyncMessagesBatch(input: PushSyncMessagesBatchInput): Promise<void> {
      const batches = chunk(input.messages, PUSH_BATCH_SIZE).map(messages =>
        messages.map(message => ({
          account: input.account,
          itemId: message.itemId,
          entry: message.entry,
          lastModified: message.lastModified,
        })),
      )

      await Promise.all(
        batches.map(async batch => {
          const response = await docClient.send(new BatchWriteCommand({
            RequestItems: {
              [config.syncMessagesTable]: batch.map(message => ({
                PutRequest: {
                  Item: {
                    syncId: `${input.account}#${message.itemId}`,
                    cursor: message.entry.cursor,
                    encryptedMessage: message.entry.encryptedMessage,
                    createdAt: message.entry.createdAt,
                    expiresAt: Math.floor(Date.now() / 1000) + SYNC_MESSAGE_TTL,
                  },
                },
              })),
            },
          }))

          if (response.UnprocessedItems && Object.keys(response.UnprocessedItems).length > 0) {
            throw new Error('Failed to write all sync messages in batch.')
          }
        }),
      )
    },

    async getSyncMessages(input: {
      account: string
      itemId: string
      fromCursor?: number
      limit?: number
    }): Promise<{ messages: StoredSyncMessage[]; hasMore: boolean }> {
      const fromCursor = typeof input.fromCursor === 'number' ? input.fromCursor : undefined
      const hasCursor = typeof fromCursor === 'number'
      const response = await docClient.send(new QueryCommand({
        TableName: config.syncMessagesTable,
        KeyConditionExpression: hasCursor
          ? 'syncId = :syncId AND #c > :fromCursor'
          : 'syncId = :syncId',
        ExpressionAttributeNames: hasCursor
          ? { '#c': 'cursor' }
          : undefined,
        ExpressionAttributeValues: {
          ':syncId': `${input.account}#${input.itemId}`,
          ...(hasCursor ? { ':fromCursor': fromCursor } : undefined),
        },
        Limit: input.limit ?? DEFAULT_SYNC_MESSAGE_LIMIT,
      }))

      return {
        messages: (response.Items as StoredSyncMessage[]) || [],
        hasMore: !!response.LastEvaluatedKey,
      }
    },

    async pruneSyncMessagesUpToCursor(input: { account: string; itemId: string; cursor: number }): Promise<number> {
      const syncId = `${input.account}#${input.itemId}`
      let deleted = 0
      let lastEvaluatedKey: Record<string, unknown> | undefined

      do {
        const response = await docClient.send(new QueryCommand({
          TableName: config.syncMessagesTable,
          KeyConditionExpression: 'syncId = :syncId AND #c <= :cursor',
          ExpressionAttributeNames: { '#c': 'cursor' },
          ExpressionAttributeValues: {
            ':syncId': syncId,
            ':cursor': input.cursor,
          },
          ProjectionExpression: '#c',
          ExclusiveStartKey: lastEvaluatedKey,
          Limit: PUSH_BATCH_SIZE,
        }))

        const items = (response.Items as Array<{ cursor: number }>) || []
        if (items.length > 0) {
          const deleteResponse = await docClient.send(new BatchWriteCommand({
            RequestItems: {
              [config.syncMessagesTable]: items.map(item => ({
                DeleteRequest: {
                  Key: {
                    syncId,
                    cursor: item.cursor,
                  },
                },
              })),
            },
          }))

          if (deleteResponse.UnprocessedItems && Object.keys(deleteResponse.UnprocessedItems).length > 0) {
            throw new Error('Failed to delete all sync messages in batch.')
          }

          deleted += items.length
        }

        lastEvaluatedKey = response.LastEvaluatedKey
      } while (lastEvaluatedKey)

      return deleted
    },
  }
}
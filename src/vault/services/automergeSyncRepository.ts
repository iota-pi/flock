import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb'
import type { AutomergeSyncConfig } from './automergeSyncConfig'

const SYNC_MESSAGE_TTL = 60 * 24 * 60 * 60

export type StoredSyncMessage = {
  cursor: number
  encryptedMessage: {
    iv: string
    cipher: string
    version?: string
  }
  createdAt: number
}

export type AppendSyncMessageInput = {
  account: string
  itemId: string
  entry: StoredSyncMessage
  lastModified: number
}

export interface AutomergeSyncRepository {
  appendSyncMessage(input: AppendSyncMessageInput): Promise<void>
  getSyncMessages(input: { account: string; itemId: string }): Promise<StoredSyncMessage[]>
}

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

    async getSyncMessages(input: { account: string; itemId: string }): Promise<StoredSyncMessage[]> {
      const response = await docClient.send(new QueryCommand({
        TableName: config.syncMessagesTable,
        KeyConditionExpression: 'syncId = :syncId',
        ExpressionAttributeValues: {
          ':syncId': `${input.account}#${input.itemId}`,
        },
      }))

      return (response.Items as StoredSyncMessage[]) || []
    },
  }
}
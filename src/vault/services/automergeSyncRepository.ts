import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb'
import type { AutomergeSyncConfig } from './automergeSyncConfig'

export type StoredSyncMessage = {
  cursor: number
  encryptedMessage: {
    iv: string
    cipher: string
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
      await docClient.send(new UpdateCommand({
        TableName: config.itemsTable,
        Key: {
          account: input.account,
          item: input.itemId,
        },
        UpdateExpression: 'SET #syncMessages = list_append(if_not_exists(#syncMessages, :empty), :newEntries), #lastModified = :lastModified',
        ExpressionAttributeNames: {
          '#syncMessages': 'syncMessages',
          '#lastModified': 'syncLastModified',
        },
        ExpressionAttributeValues: {
          ':empty': [],
          ':newEntries': [input.entry],
          ':lastModified': input.lastModified,
        },
      }))
    },

    async getSyncMessages(input: { account: string; itemId: string }): Promise<StoredSyncMessage[]> {
      const response = await docClient.send(new GetCommand({
        TableName: config.itemsTable,
        Key: {
          account: input.account,
          item: input.itemId,
        },
      }))

      return Array.isArray(response.Item?.syncMessages)
        ? response.Item.syncMessages as StoredSyncMessage[]
        : []
    },
  }
}
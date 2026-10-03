import type BaseDriver from '../drivers/base'
import type { ItemId } from 'src/shared/schemas/items'
import type { StoredSyncMessage } from '../drivers/base'
import type {
  SyncMessageLastEvaluatedKey,
  GlobalSyncLastEvaluatedKey,
} from 'src/shared/schemas/trpc'

type AppendSyncMessageInput = {
  account: string
  itemId: ItemId
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
    itemId: ItemId
    fromCursor?: number
    limit?: number
    exclusiveStartKey?: SyncMessageLastEvaluatedKey
  }): Promise<{ messages: StoredSyncMessage[]; hasMore: boolean; lastEvaluatedKey?: SyncMessageLastEvaluatedKey }>
  getGlobalSyncMessagesAfterCursor(input: {
    account: string
    cursor?: number
    exclusiveStartKey?: GlobalSyncLastEvaluatedKey
  }): Promise<{ items: Array<{ itemId: ItemId, messages: StoredSyncMessage[] }>; hasMore: boolean; lastEvaluatedKey?: GlobalSyncLastEvaluatedKey }>
}

export function createDynamoAutomergeSyncRepository(driver: BaseDriver): AutomergeSyncRepository {
  return {
    async appendSyncMessage(input: AppendSyncMessageInput): Promise<void> {
      await driver.appendSyncMessage(input)
    },

    async pushSyncMessagesBatch(input: PushSyncMessagesBatchInput): Promise<void> {
      await driver.pushSyncMessagesBatch({
        account: input.account,
        messages: input.messages.map(m => ({
          itemId: m.itemId,
          entry: m.entry,
          lastModified: m.lastModified,
        })),
      })
    },

    async getSyncMessages(input: {
      account: string
      itemId: ItemId
      fromCursor?: number
      limit?: number
      exclusiveStartKey?: SyncMessageLastEvaluatedKey
    }): Promise<{ messages: StoredSyncMessage[]; hasMore: boolean; lastEvaluatedKey?: SyncMessageLastEvaluatedKey }> {
      return driver.getSyncMessages(input)
    },

    async getGlobalSyncMessagesAfterCursor(input: {
      account: string
      cursor?: number
      exclusiveStartKey?: GlobalSyncLastEvaluatedKey
    }): Promise<{ items: Array<{ itemId: ItemId, messages: StoredSyncMessage[] }>; hasMore: boolean; lastEvaluatedKey?: GlobalSyncLastEvaluatedKey }> {
      return driver.getGlobalSyncMessagesAfterCursor(input)
    },
  }
}
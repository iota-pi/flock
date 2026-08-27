import type BaseDriver from '../drivers/base'
import type { ItemId } from 'src/shared/schemas/items'
import type { StoredSyncMessage } from '../drivers/base'

export type { StoredSyncMessage }

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
  }): Promise<{ messages: StoredSyncMessage[]; hasMore: boolean }>
  getGlobalSyncMessagesAfterCursor(input: {
    account: string
    cursor: number
  }): Promise<{ items: Array<{ itemId: ItemId, messages: StoredSyncMessage[] }>; hasMore: boolean }>
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
    }): Promise<{ messages: StoredSyncMessage[]; hasMore: boolean }> {
      return driver.getSyncMessages(input)
    },

    async getGlobalSyncMessagesAfterCursor(input: {
      account: string
      cursor: number
    }): Promise<{ items: Array<{ itemId: ItemId, messages: StoredSyncMessage[] }>; hasMore: boolean }> {
      return driver.getGlobalSyncMessagesAfterCursor(input)
    },
  }
}
import type BaseDriver from '../drivers/base'
import type { StoredSyncMessage } from '../drivers/base'

export type { StoredSyncMessage }

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
      itemId: string
      fromCursor?: number
      limit?: number
    }): Promise<{ messages: StoredSyncMessage[]; hasMore: boolean }> {
      return driver.getSyncMessages(input)
    },

    async pruneSyncMessagesUpToCursor(input: { account: string; itemId: string; cursor: number }): Promise<number> {
      return driver.pruneSyncMessagesUpToCursor(input)
    },
  }
}
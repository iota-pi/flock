import type BaseDriver from '../drivers/base'
import type { ItemId, PageToken } from '@vault/shared'
import type { StoredSyncMessage } from '../drivers/base'

type PushSyncMessagesBatchInput = {
  account: string
  messages: Array<{
    itemId: ItemId
    entry: StoredSyncMessage
    lastModified: number
  }>
}

export interface AutomergeSyncRepository {
  pushSyncMessagesBatch(input: PushSyncMessagesBatchInput): Promise<void>
  getSyncMessages(input: {
    account: string
    itemId: ItemId
    fromCursor?: number
    limit?: number
    pageToken?: PageToken
  }): Promise<{ messages: StoredSyncMessage[]; hasMore: boolean; nextPageToken?: PageToken }>
  getGlobalSyncMessagesAfterCursor(input: {
    account: string
    cursor?: number
    pageToken?: PageToken
  }): Promise<{ items: Array<{ itemId: ItemId, messages: StoredSyncMessage[] }>; hasMore: boolean; nextPageToken?: PageToken; scannedThroughCursor: number }>
  validatePageToken(input: { account: string; itemId?: ItemId; cursor?: number; pageToken: PageToken }): void
}

export function createDynamoAutomergeSyncRepository(driver: BaseDriver): AutomergeSyncRepository {
  return {
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
      pageToken?: PageToken
    }): Promise<{ messages: StoredSyncMessage[]; hasMore: boolean; nextPageToken?: PageToken }> {
      return driver.getSyncMessages(input)
    },

    async getGlobalSyncMessagesAfterCursor(input: {
      account: string
      cursor?: number
      pageToken?: PageToken
    }): Promise<{ items: Array<{ itemId: ItemId, messages: StoredSyncMessage[] }>; hasMore: boolean; nextPageToken?: PageToken; scannedThroughCursor: number }> {
      return driver.getGlobalSyncMessagesAfterCursor(input)
    },

    validatePageToken(input: { account: string; itemId?: ItemId; cursor?: number; pageToken: PageToken }): void {
      driver.validatePageToken(input)
    },
  }
}
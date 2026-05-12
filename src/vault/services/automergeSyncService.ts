import { resolveAutomergeSyncConfig } from './automergeSyncConfig'
import {
  createDynamoAutomergeSyncRepository,
  type AutomergeSyncRepository,
  type StoredSyncMessage,
} from './automergeSyncRepository'

type SyncMessagePayload = {
  iv: string
  cipher: string
}

type PushSyncMessageInput = {
  account: string
  itemId: string
  encryptedMessage: SyncMessagePayload
}

type PullSyncMessageInput = {
  account: string
  itemId: string
  cursor?: number
}

type PullSyncBatchInput = {
  account: string
  cursors: Array<{
    itemId: string
    cursor?: number
  }>
}

type PushSyncBatchInput = {
  account: string
  messages: Array<{
    itemId: string
    encryptedMessage: SyncMessagePayload
  }>
}

type AutomergeSyncServiceDeps = {
  createCursor?: () => number
  now?: () => number
  repository: AutomergeSyncRepository
}

function createCursor(): number {
  return Number(`${Date.now()}${Math.floor(Math.random() * 1000).toString().padStart(3, '0')}`)
}

function sortMessagesAscendingByCursor(messages: StoredSyncMessage[]): StoredSyncMessage[] {
  return messages.slice().sort((left, right) => left.cursor - right.cursor)
}

function filterMessagesAfterCursor(messages: StoredSyncMessage[], fromCursor: number): StoredSyncMessage[] {
  return sortMessagesAscendingByCursor(
    messages.filter(message => typeof message.cursor === 'number' && message.cursor > fromCursor),
  )
}

function createAutomergeSyncService({
  createCursor: createCursorInput = createCursor,
  now = Date.now,
  repository,
}: AutomergeSyncServiceDeps) {
  async function appendSyncMessage(input: PushSyncMessageInput): Promise<number> {
    const cursor = createCursorInput()
    const timestamp = now()

    await repository.appendSyncMessage({
      account: input.account,
      itemId: input.itemId,
      entry: {
        cursor,
        encryptedMessage: input.encryptedMessage,
        createdAt: timestamp,
      },
      lastModified: timestamp,
    })

    return cursor
  }

  async function pushAutomergeSyncBatch(input: PushSyncBatchInput): Promise<{ success: true; results: Array<{ itemId: string; cursor: number }> }> {
    const results = await Promise.all(
      input.messages.map(async message => {
        const cursor = await appendSyncMessage({
          account: input.account,
          itemId: message.itemId,
          encryptedMessage: message.encryptedMessage,
        })

        return { itemId: message.itemId, cursor }
      })
    )

    return {
      success: true,
      results,
    }
  }

  async function pullAutomergeSyncMessages(input: PullSyncMessageInput): Promise<{
    success: true
    itemId: string
    nextCursor: number
    messages: StoredSyncMessage[]
  }> {
    const fromCursor = typeof input.cursor === 'number' ? input.cursor : 0
    const storedMessages = await repository.getSyncMessages({
      account: input.account,
      itemId: input.itemId,
    })

    const messages = filterMessagesAfterCursor(storedMessages, fromCursor)
    const nextCursor = messages.length > 0
      ? messages[messages.length - 1].cursor
      : fromCursor

    return {
      success: true,
      itemId: input.itemId,
      nextCursor,
      messages,
    }
  }

  async function pullAutomergeSyncBatch(input: PullSyncBatchInput): Promise<{
    success: true
    results: Array<{
      success: true
      itemId: string
      nextCursor: number
      messages: StoredSyncMessage[]
    }>
  }> {
    const dedupedCursorsByItemId = new Map<string, number>()
    for (const cursorInput of input.cursors) {
      const existing = dedupedCursorsByItemId.get(cursorInput.itemId) || 0
      const next = typeof cursorInput.cursor === 'number' ? cursorInput.cursor : 0
      dedupedCursorsByItemId.set(cursorInput.itemId, Math.max(existing, next))
    }

    const results = await Promise.all(
      Array
        .from(dedupedCursorsByItemId.entries())
        .map(([itemId, cursor]) => pullAutomergeSyncMessages({
          account: input.account,
          itemId,
          cursor,
        })),
    )

    return {
      success: true,
      results,
    }
  }

  return {
    pullAutomergeSyncBatch,
    pushAutomergeSyncBatch,
  }
}

const automergeSyncService = createAutomergeSyncService({
  repository: createDynamoAutomergeSyncRepository(resolveAutomergeSyncConfig()),
})

export const pullAutomergeSyncBatch = automergeSyncService.pullAutomergeSyncBatch
export const pushAutomergeSyncBatch = automergeSyncService.pushAutomergeSyncBatch

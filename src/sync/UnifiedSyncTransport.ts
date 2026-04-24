import { EventEmitter } from 'eventemitter3'
import { SyncTransportService } from './SyncTransportService'
import { SyncPullQueueManager } from './SyncPullQueueManager'
import { interpretAsDocumentId, type DocumentId } from '@automerge/automerge-repo/slim'
import { toAutomergeUrlFromItemId, toVaultItemIdFromAutomergeId } from './automergeRepoIds'
import { decryptSyncMessage } from './automergeSyncCrypto'
import { clearManualRecoveryForItems } from '../api/syncHealthCoordinator'
import type { RealtimeDirectSyncPush } from '../shared/realtime'
import { ACCOUNT_INDEX_DOCUMENT_ID } from './automergeConstants'

function normalizeItemIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }

  const deduped = new Set<string>()
  for (const itemId of value) {
    if (typeof itemId !== 'string' || itemId.length === 0) {
      continue
    }

    deduped.add(toVaultItemIdFromAutomergeId(itemId))
  }

  return Array.from(deduped)
}

function normalizeEventItemIds(payload: { data?: { itemIds?: unknown; deletedItemIds?: unknown } }): string[] {
  return [
    ...normalizeItemIds(payload.data?.itemIds),
    ...normalizeItemIds(payload.data?.deletedItemIds),
  ]
}

function withIndexDocumentPriority(itemIds: string[]): string[] {
  const normalized = normalizeItemIds(itemIds)
  const deduped = new Set<string>([ACCOUNT_INDEX_DOCUMENT_ID])

  for (const itemId of normalized) {
    if (itemId !== ACCOUNT_INDEX_DOCUMENT_ID) {
      deduped.add(itemId)
    }
  }

  return Array.from(deduped)
}

export class UnifiedSyncTransport extends EventEmitter {
  private transportService = new SyncTransportService()
  private pullQueueManager = new SyncPullQueueManager()
  private account: string | null = null

  constructor() {
    super()

    this.transportService.on('open', () => {
      this.emit('open')
    })

    this.transportService.on('close', () => {
      this.emit('close')
    })

    this.transportService.on('message', async (payload: unknown) => {
      if (!payload || typeof payload !== 'object') return
      const anyPayload = payload as Record<string, unknown>

      if ('action' in anyPayload) {
        if (anyPayload.action === 'sync_ping') {
          this.handleRealtimeItemHints(normalizeItemIds(anyPayload.itemIds))
          return
        }

        if (anyPayload.action === 'direct_sync_push') {
          await this.handleDirectSyncPush(anyPayload as unknown as RealtimeDirectSyncPush)
          return
        }
      }

      if ('eventType' in anyPayload && (anyPayload.eventType === 'items.updated' || anyPayload.eventType === 'items.deleted')) {
        this.handleRealtimeItemHints(normalizeEventItemIds({ data: anyPayload.data as { itemIds?: unknown; deletedItemIds?: unknown } }))
      }
    })

    this.pullQueueManager.onMessageParsed = (itemId, documentId, message) => {
      this.emitParsedMessage(itemId, documentId, message)
    }
  }

  setAccount(account: string | null): void {
    this.account = account
    this.pullQueueManager.setAccount(account)

    if (account) {
      this.transportService.start(account)
    } else {
      this.transportService.stop()
    }
  }

  enqueueSend(task: () => Promise<void>): void {
    this.transportService.enqueueSend(task)
  }

  sendRaw(action: string, itemId: string, encryptedMessage: unknown): void {
    this.transportService.sendRaw(action, itemId, encryptedMessage)
  }

  clearQueue(): void {
    this.pullQueueManager.clear()
  }

  removeKnownItemIds(itemIds: string[]): void {
    this.pullQueueManager.removeKnownItemIds(itemIds)
  }

  enqueuePull(itemIds: string[]): void {
    if (!this.account) return
    const prioritized = withIndexDocumentPriority(itemIds)
    void this.pullQueueManager.enqueuePull(prioritized).catch(error => {
      console.error('[UnifiedSyncTransport] enqueuePull failed', error)
    })
  }

  private handleRealtimeItemHints(itemIds: string[]): void {
    this.enqueuePull(itemIds)
  }

  private async handleDirectSyncPush(payload: RealtimeDirectSyncPush): Promise<void> {
    try {
      if (!payload.encryptedMessage?.iv || !payload.encryptedMessage?.cipher) return
      const decrypted = await decryptSyncMessage(payload.encryptedMessage)
      const itemId = toVaultItemIdFromAutomergeId(payload.itemId)
      const documentId = interpretAsDocumentId(toAutomergeUrlFromItemId(itemId))

      // Also tell pull queue to advance cursor
      // (The queue manager will update its internal max cursor via fetching later or we can manually set it, 
      // but for simplicity, the next HTTP pull will reconcile it anyway, or we let the pull queue know.
      // But we just emit the message so Automerge gets it instantly!)
      this.emitParsedMessage(itemId, documentId as DocumentId, decrypted)
    } catch (error) {
      console.error('[UnifiedSyncTransport] Failed to decrypt direct push payload', error)
      // Fallback to queue if decryption failed or something
      this.enqueuePull([payload.itemId])
    }
  }

  private emitParsedMessage(itemId: string, documentId: DocumentId, message: Uint8Array): void {
    clearManualRecoveryForItems([itemId]).catch(console.error)
    this.emit('message', { itemId, documentId, message })
  }
}

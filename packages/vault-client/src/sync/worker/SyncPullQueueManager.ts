import { interpretAsDocumentId, type DocumentId } from '@automerge/automerge-repo/slim'
import { debounce } from 'lodash-es'

import type { PullSyncMessagesResponse } from './SyncApiClient'
import type { KeyProvider } from '../../api/Keyring'
import { toAutomergeUrlFromItemId } from './utils/automerge'
import type { RealtimeBus } from './realtimeBus'
import type { SyncSessionState } from './SyncSessionState'
import { decryptWithKeyResolution } from './utils/decryptWithKeyResolution'
import { classifySyncError } from '../utils/errorClassifier'
import type { ItemId, PageToken } from '@vault/shared'
import type { CursorStore } from './stores/CursorStore'
import { parseBatchedMessages } from './utils/messageParser'
import type { ItemLockCoordinator } from './docStore'
import { PullCursorState, type PullFailure } from './PullCursorState'
import { BatchProgress } from './BatchProgress'
import type { VaultNetworkAdapter } from './VaultNetworkAdapter'
import { BoundedSet } from '../utils/BoundedSet'
import { SYNC_TIMEOUTS } from '../shared/syncConfig'
import { fireAndForget } from '../utils/fireAndForget'
import { createLogger } from '../utils/logger'

const log = createLogger('SyncPullQueueManager')

interface ProcessItemMessagesResult {
  highestCursor: number
  /** Why processing stopped before the last message, if it did */
  failure?: PullFailure
  hasParsedMessages: boolean
  hasParsedRemoteMessages: boolean
}

type HandledMessageEntry =
  | { parsed: true; cursor: number }
  | { parsed: false; missingKey?: boolean; kver?: string }

const OWN_PUSH_CACHE_MAX = 1000
const KEY_WAIT_TIMEOUT_MS = SYNC_TIMEOUTS.keyWait

export interface SyncPullQueueManagerDeps {
  /** The account's stored cursors */
  cursorStore: CursorStore
  keys: KeyProvider
  lockCoordinator: ItemLockCoordinator
  /** Receives each pulled sync message */
  adapter: Pick<VaultNetworkAdapter, 'receiveServerMessage'>
  session: SyncSessionState
  /** Tells the account's other tabs which items were pulled */
  bus?: RealtimeBus
  onKeyVersionMissing?: (kver: string) => void
  /** Called with each item a message was pulled for, before the adapter receives the message */
  onItemMessageParsed?: (itemId: ItemId) => void
  /** Asks the orchestrator to poll, once pulls held back for a missing key can go ahead */
  onFlushNeeded?: () => void
  /** Called when whether any item's pull is being retried changes */
  onRetryingChange?: (isRetrying: boolean) => void
  /** Called with an item once messages other devices pushed for it have been applied */
  onRemoteMessagesParsed?: (itemId: ItemId) => void
  /** Called with an item whose pulled messages failed to parse for good */
  onDecryptionFailure?: (itemId: ItemId, error: unknown) => void
}

export class SyncPullQueueManager {
  private readonly cursorStore: CursorStore
  private readonly keys: KeyProvider
  private readonly lockCoordinator: ItemLockCoordinator
  private readonly adapter: Pick<VaultNetworkAdapter, 'receiveServerMessage'>
  private readonly session: SyncSessionState
  private readonly bus: RealtimeBus | null
  private readonly onKeyVersionMissing?: (kver: string) => void
  private readonly onItemMessageParsed?: (itemId: ItemId) => void
  private readonly onFlushNeeded?: () => void
  private readonly onRetryingChange?: (isRetrying: boolean) => void
  private readonly onRemoteMessagesParsed?: (itemId: ItemId) => void
  private readonly onDecryptionFailure?: (itemId: ItemId, error: unknown) => void

  /** Where each item's pulls, and the account-wide scan, have reached */
  readonly cursors: PullCursorState
  private hasMoreGlobal = false
  private globalPageToken?: PageToken

  private readonly batchProgress = new BatchProgress()
  // "itemId:cursor" of messages this device pushed, so their server echoes aren't mistaken for remote edits
  private readonly ownPushedMessageKeys = new BoundedSet<string>(OWN_PUSH_CACHE_MAX)

  // A pull that finishes after shutdown mustn't save, since shutdown may be clearing local data
  private readonly saveCursorsDebounced = debounce(() => {
    if (this.session.isShutdown) return
    fireAndForget(this.persistCursors(), 'SyncPullQueueManager:persistCursors')
  }, 1000)

  constructor(deps: SyncPullQueueManagerDeps) {
    this.cursorStore = deps.cursorStore
    this.keys = deps.keys
    this.lockCoordinator = deps.lockCoordinator
    this.adapter = deps.adapter
    this.session = deps.session
    this.bus = deps.bus ?? null
    this.onKeyVersionMissing = deps.onKeyVersionMissing
    this.onItemMessageParsed = deps.onItemMessageParsed
    this.onFlushNeeded = deps.onFlushNeeded
    this.onRetryingChange = deps.onRetryingChange
    this.onRemoteMessagesParsed = deps.onRemoteMessagesParsed
    this.onDecryptionFailure = deps.onDecryptionFailure
    this.cursors = new PullCursorState(deps.keys)
  }

  private makeOwnPushKey(itemId: ItemId, cursor: number): string {
    return `${itemId}:${cursor}`
  }

  recordOwnPushedMessage(itemId: ItemId, cursor: number): void {
    this.ownPushedMessageKeys.add(this.makeOwnPushKey(itemId, cursor))
  }

  /** Drops the per-item pull state held in memory. The persisted cursors are left alone. */
  private clearPullState(): void {
    this.cursors.clear()
    this.batchProgress.clearAll()
    this.ownPushedMessageKeys.clear()
  }

  async loadCursors(): Promise<void> {
    if (this.session.isShutdown) return
    try {
      const stored = await this.cursorStore.loadCursors()
      if (stored) {
        this.cursors.loadState(stored)
      }
    } catch (error) {
      log.error('Failed to load cursors', error)
    }
  }

  private async persistCursors(): Promise<void> {
    const data = this.cursors.exportState()
    try {
      await this.cursorStore.saveCursors(data)
    } catch (error) {
      log.error('Failed to save cursors', error)
    }
  }

  /** Saves the cursors, unless local data is being cleared. Called once, by the context's lifecycle. */
  async shutdown(options?: { clearLocalData?: boolean }): Promise<void> {
    this.saveCursorsDebounced.cancel()
    if (!options?.clearLocalData) {
      await this.persistCursors()
    }
    this.clearPullState()
    this.hasMoreGlobal = false
  }

  /** Hands a pulled message to the adapter. If the adapter throws, the batch stops there and is retried. */
  private deliverMessage(itemId: ItemId, documentId: DocumentId, message: Uint8Array): void {
    this.onItemMessageParsed?.(itemId)
    this.adapter.receiveServerMessage(documentId, message)
  }

  private async handleMessageEntry(
    itemId: ItemId,
    documentId: DocumentId,
    entry: PullSyncMessagesResponse['messages'][number],
    timedOutKeys?: Set<string>,
  ): Promise<HandledMessageEntry> {
    if (!entry.encryptedMessage?.iv || !entry.encryptedMessage?.cipher) {
      return { parsed: false }
    }

    let decrypted: Uint8Array
    try {
      decrypted = await decryptWithKeyResolution(this.keys, entry.encryptedMessage, {
        docId: itemId,
        timeoutMs: KEY_WAIT_TIMEOUT_MS,
        timedOutKeys,
        onKeyVersionMissing: this.onKeyVersionMissing,
      })
    } catch (error) {
      const classified = classifySyncError(error)
      if (classified.isMissingKey) {
        return { parsed: false, missingKey: true, kver: classified.kver }
      }
      return { parsed: false }
    }

    // Every push since 2026-05-19 is a batch packed by packBatchedMessages, and the 90-day TTL has
    // expired anything older
    const success = parseBatchedMessages(
      decrypted,
      msg => this.deliverMessage(itemId, documentId, msg),
      {
        startIndex: this.batchProgress.get(itemId, entry.cursor),
        onMessageSuccess: index => {
          this.batchProgress.set(itemId, entry.cursor, index + 1)
        },
      }
    )
    if (!success) {
      return { parsed: false }
    }

    return { parsed: true, cursor: entry.cursor }
  }

  hasImmediatePendingPulls(): boolean {
    if (this.hasMoreGlobal) {
      return true
    }
    return this.cursors.hasImmediatePendingPulls()
  }

  onKeyringUpdated(): void {
    const unblockedAny = this.cursors.onKeyringUpdated()
    if (unblockedAny) {
      this.onRetryingChange?.(this.cursors.isAnyRetrying())
      this.onFlushNeeded?.()
    }
  }

  /**
   * Abandons in-progress paginations after the server rejected a page token: the next poll
   * restarts the account-wide scan from the persisted scan cursor, and pending items continue
   * from their cursors.
   */
  resetPagination(): void {
    this.hasMoreGlobal = false
    this.globalPageToken = undefined
    this.cursors.clearPageTokens()
  }

  getGlobalPageToken(): PageToken | undefined {
    return this.hasMoreGlobal ? this.globalPageToken : undefined
  }

  private async processItemMessages(
    itemId: ItemId,
    messages: PullSyncMessagesResponse['messages'] | undefined,
    initialCursor: number,
    timedOutKeys: Set<string>
  ): Promise<ProcessItemMessagesResult> {
    const documentId = interpretAsDocumentId(toAutomergeUrlFromItemId(itemId))

    // Sort messages ascending by cursor to ensure causal processing order and prevent
    // out-of-order cursors from prematurely advancing state.cursor if an earlier cursor fails.
    const sortedMessages = [...(messages || [])].sort((a, b) => a.cursor - b.cursor)

    if (sortedMessages.length === 0) {
      return { highestCursor: initialCursor, hasParsedMessages: false, hasParsedRemoteMessages: false }
    }

    return this.lockCoordinator.withItemLock(itemId, async () => {
      let highestCursor = initialCursor
      let failure: PullFailure | undefined
      let hasParsedMessages = false
      let hasParsedRemoteMessages = false

      for (const entry of sortedMessages) {
        if (entry.cursor <= initialCursor) {
          this.batchProgress.clear(itemId, entry.cursor)
          highestCursor = Math.max(highestCursor, entry.cursor)
          continue
        }

        const handled = await this.handleMessageEntry(itemId, documentId, entry, timedOutKeys)
        if (handled.parsed) {
          hasParsedMessages = true
          const ownKey = this.makeOwnPushKey(itemId, handled.cursor)
          if (!this.ownPushedMessageKeys.has(ownKey)) {
            hasParsedRemoteMessages = true
          }
          this.ownPushedMessageKeys.delete(ownKey)
          this.batchProgress.clear(itemId, handled.cursor)
          highestCursor = Math.max(highestCursor, handled.cursor)
        } else if (handled.missingKey) {
          failure = { kind: 'keyMissing', kver: handled.kver }
          break
        } else {
          failure = { kind: 'parseFailure', cursor: entry.cursor }
          break
        }
      }

      return { highestCursor, failure, hasParsedMessages, hasParsedRemoteMessages }
    })
  }

  private async processSinglePullResult(
    result: PullSyncMessagesResponse,
    timedOutKeys: Set<string>,
  ): Promise<{ itemId: ItemId; hasParsedMessages: boolean; cursorUpdated: boolean }> {
    const itemId = result.itemId
    const hasMore = result.hasMore === true
    const isNewItem = !this.cursors.hasState(itemId)
    const initialCursor = this.cursors.getCursor(itemId)

    const messageResult = await this.processItemMessages(
      itemId,
      result.messages,
      initialCursor,
      timedOutKeys
    )

    const { failure } = messageResult
    let highestCursor = messageResult.highestCursor
    if (!failure && Number.isFinite(result.nextCursor)) {
      highestCursor = Math.max(highestCursor, result.nextCursor)
    }

    const outcome = this.cursors.recordPullOutcome({
      itemId,
      highestCursor,
      isNewItem,
      failure,
      hasMore,
      nextCursor: result.nextCursor,
      pageToken: result.nextPageToken,
    })

    if (highestCursor > initialCursor) {
      this.batchProgress.clearUpTo(itemId, highestCursor)
    }

    if (outcome.permanentlyFailed || (!failure && !hasMore)) {
      this.batchProgress.clearItem(itemId)
    }

    if (messageResult.hasParsedRemoteMessages && !failure && !outcome.permanentlyFailed) {
      this.onRemoteMessagesParsed?.(itemId)
    }

    if (outcome.permanentlyFailed) {
      const err = new Error(
        `Permanently failed to parse sync messages after ${PullCursorState.MAX_PULL_RETRIES} attempts`
      )
      this.onDecryptionFailure?.(itemId, err)
    }

    return {
      itemId,
      hasParsedMessages: messageResult.hasParsedMessages,
      cursorUpdated: outcome.cursorUpdated,
    }
  }

  /**
   * @param globalScannedThroughCursor Global scan position reported by the server. Only it advances
   * the global cursor; per-item results (which may run ahead of the scan) never do.
   */
  async processPullResults(
    results: PullSyncMessagesResponse[],
    hasMoreGlobal: boolean,
    globalNextPageToken: PageToken | undefined,
    globalScannedThroughCursor: number | undefined,
  ): Promise<void> {
    if (this.session.isShutdown) return
    this.hasMoreGlobal = hasMoreGlobal
    this.globalPageToken = hasMoreGlobal ? globalNextPageToken : undefined

    const successfullyPulledItemIds = new Set<ItemId>()
    let cursorsUpdated = false
    const timedOutKeys = new Set<string>()
    // One bad item must not block the others, but the poll must still report failure
    // (sync rule 4), so the first per-item error is re-thrown after the loop.
    let firstItemError: { error: unknown } | undefined

    try {
      for (const result of results || []) {
        try {
          const itemOutcome = await this.processSinglePullResult(result, timedOutKeys)
          if (itemOutcome.hasParsedMessages) {
            successfullyPulledItemIds.add(itemOutcome.itemId)
          }
          if (itemOutcome.cursorUpdated) {
            cursorsUpdated = true
          }
        } catch (innerError) {
          log.error(`Pull sync failed for item: ${result.itemId}`, innerError)
          firstItemError ??= { error: innerError }
        }
      }

      if (typeof globalScannedThroughCursor === 'number') {
        const previous = this.cursors.getGlobalScanCursor()
        this.cursors.setGlobalCursor(globalScannedThroughCursor)
        if (this.cursors.getGlobalScanCursor() !== previous) {
          cursorsUpdated = true
        }
      }

      if (cursorsUpdated) {
        this.saveCursorsDebounced()
      }

      if (firstItemError) {
        throw firstItemError.error
      }
    } finally {
      this.onRetryingChange?.(this.cursors.isAnyRetrying())
      if (successfullyPulledItemIds.size > 0) {
        this.bus?.publishSyncPing(Array.from(successfullyPulledItemIds))
      }
    }
  }

  async importCursors(cursors: [ItemId, number][]): Promise<void> {
    this.cursors.importCursors(cursors)
    for (const [itemId, cursor] of cursors) {
      this.batchProgress.clearUpTo(itemId, cursor)
    }
    await this.cursorStore.saveCursors(this.cursors.exportState())
  }
}

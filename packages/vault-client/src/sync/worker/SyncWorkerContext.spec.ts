import { SyncWorkerContext } from './SyncWorkerContext'
import { INBOUND_MESSAGE_RESOLVABLE_KINDS } from './RecoveryManager'
import { ClientEventHub, WorkerInternalEventHub } from './SyncEventHub'
import { createMockKeyProvider, createTestEventHubs } from './__test__/testUtils'
import type { ItemId } from '@vault/shared'
import type { DocumentId } from '@automerge/automerge-repo/slim'
import { clearSyncMetadataStorage } from './stores/syncMetadataStorage'
import { publishRealtimeBusItemDirty } from './realtimeBus'
import { MigrationRequiredError } from './DataVersionTracker'
import { SnapshotFormatUpgrade } from './SnapshotFormatUpgrade'
import { AbortError } from '../utils/abort'

// ── Internalized store mocks ─────────────────────────────────────────────────

const mockRecoveryEntries = vi.hoisted(() => new Map<string, any>())

vi.mock('../shared/manualRecoveryStore', () => ({
  readManualRecoveryEntries: vi.fn(async () => Array.from(mockRecoveryEntries.values())),
  readManualRecoveryCount: vi.fn(async () => mockRecoveryEntries.size),
  removeManualRecoveryEntryById: vi.fn(async (_acc: string, id: string) => { mockRecoveryEntries.delete(id) }),
  removeManualRecoveryEntryByItemId: vi.fn(async (_acc: string, id: string) => { mockRecoveryEntries.delete(id) }),
  removeManualRecoveryEntryIfKind: vi.fn(async (_acc: string, id: string, kinds: ReadonlySet<string>) => {
    const entry = mockRecoveryEntries.get(id)
    if (!entry || !kinds.has(entry.kind)) return false
    mockRecoveryEntries.delete(id)
    return true
  }),
  upsertManualRecoveryEntry: vi.fn(async (_acc: string, input: any) => {
    const entry = { id: input.itemId, createdAt: Date.now(), ...input }
    mockRecoveryEntries.set(input.itemId, entry)
    return entry
  }),
}))

vi.mock('./stores/syncMetadataStorage', () => ({
  clearSyncMetadataStorage: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('./stores/CursorStore', () => ({
  CursorStore: class MockCursorStore {
    clear = vi.fn().mockResolvedValue(undefined)
  },
}))

vi.mock('./stores/IndexStore', () => ({
  IndexStore: class MockIndexStore {
    clear = vi.fn().mockResolvedValue(undefined)
    hasIndex = vi.fn().mockResolvedValue(false)
    getIndex = vi.fn().mockResolvedValue(null)
  },
}))

vi.mock('./SyncWriteAheadLog', () => ({
  SyncWriteAheadLog: class MockSyncWriteAheadLog {
    clear = vi.fn().mockResolvedValue(undefined)
    handleQuotaExceeded = vi.fn().mockResolvedValue(1)
    append = vi.fn().mockResolvedValue(undefined)
    readAll = vi.fn().mockResolvedValue(new Map())
  },
}))

vi.mock('./docStore', () => ({
  AutomergeDocStore: class MockAutomergeDocStore {
    readonly lifecycleName = 'DocStore'
    shutdown = vi.fn().mockResolvedValue(undefined)
    saveDocToStorage = vi.fn().mockResolvedValue(undefined)
    readItemSnapshot = vi.fn().mockResolvedValue(null)
    onLifecycleStop = vi.fn().mockImplementation(async () => {
      await this.shutdown()
    })
  },
  AutomergeIndexManager: class MockAutomergeIndexManager {
    readonly lifecycleName = 'IndexManager'
    ensureIndexDocument = vi.fn().mockResolvedValue(undefined)
    addAutomergeItemIdsToIndex = vi.fn()
    getAutomergeMetadata = vi.fn().mockResolvedValue({})
    close = vi.fn()
    onLifecycleStart = vi.fn().mockImplementation(async () => {
      await this.ensureIndexDocument()
    })

    onLifecycleStop = vi.fn().mockImplementation(() => {
      this.close()
    })
  },
}))

vi.mock('./SyncPullQueueManager', () => ({
  SyncPullQueueManager: class MockSyncPullQueueManager {
    readonly lifecycleName = 'PullQueueManager'
    setLockCoordinator = vi.fn()
    getGlobalLatestCursor = vi.fn().mockReturnValue(0)
    shutdown = vi.fn().mockResolvedValue(undefined)
    onLifecycleStop = vi.fn().mockImplementation(async (options?: { clearLocalData?: boolean }) => {
      await this.shutdown(options)
    })
  },
}))

vi.mock('./SyncMessageBroker', () => ({
  SyncMessageBroker: class MockSyncMessageBroker {
    readonly lifecycleName = 'SyncMessageBroker'
    unblockAllItems = vi.fn()
    setStorageRecoveryService = vi.fn()
    setRecoveryManager = vi.fn()
    poller = { executePoll: vi.fn().mockResolvedValue('success'), abort: vi.fn() }
    shutdown = vi.fn().mockResolvedValue(undefined)
    onLifecycleStop = vi.fn().mockImplementation(async () => {
      await this.shutdown()
    })
  },
}))

vi.mock('./VaultNetworkAdapter', () => ({
  VaultNetworkAdapter: class MockVaultNetworkAdapter {
    readonly lifecycleName = 'VaultNetworkAdapter'
    triggerReNegotiation = vi.fn()
    setSyncedHeadsStore = vi.fn()
    setSyncedHeads = vi.fn()
    loadSyncedHeads = vi.fn()
    resetReNegotiationCircuit = vi.fn()
    disconnect = vi.fn()
    setAccount = vi.fn()
    onLifecycleStop = vi.fn().mockImplementation(() => {
      this.disconnect()
    })
  },
}))

const mockOpenLocalStorage = vi.hoisted(() => vi.fn(async (_: string) => ({
  storage: { close: vi.fn().mockResolvedValue(undefined) },
})))

vi.mock('./localEncryption/openLocalStorage', () => ({
  openLocalStorage: mockOpenLocalStorage,
}))

vi.mock('./AutomergeRepoManager', () => ({
  AutomergeRepoManager: class MockAutomergeRepoManager {
    readonly lifecycleName = 'RepoManager'
    init = vi.fn().mockReturnValue({} /* mock Repo */)
    clearLocalData = vi.fn().mockResolvedValue(undefined)
    close = vi.fn().mockResolvedValue(undefined)
    getStorage = vi.fn().mockReturnValue(undefined)
    getStorageAdapter = vi.fn().mockReturnValue(undefined)
    onLifecycleStop = vi.fn().mockImplementation(async () => {
      await this.close()
    })
  },
}))

// ── Context-owned manager mocks ──────────────────────────────────────────────

vi.mock('./SnapshotManager', () => ({
  SnapshotManager: class MockSnapshotManager {
    readonly lifecycleName = 'SnapshotManager'
    markItemDirty = vi.fn()
    loadLastModified = vi.fn().mockResolvedValue(undefined)
    shutdown = vi.fn().mockResolvedValue(undefined)
    flushPendingSnapshots = vi.fn().mockResolvedValue({ persisted: 0, total: 0 })
    setLeader = vi.fn()
    getDirtyItemIds = vi.fn().mockReturnValue([])
    persistLastModified = vi.fn().mockResolvedValue(undefined)
    onLifecycleStart = vi.fn().mockImplementation(async () => {
      await this.loadLastModified()
    })

    onLifecycleStop = vi.fn().mockImplementation(async (options?: { clearLocalData?: boolean }) => {
      await this.shutdown(options)
    })
  },
}))

vi.mock('./SyncOrchestrator', () => ({
  SyncOrchestrator: class MockOrchestrator {
    readonly lifecycleName = 'SyncOrchestrator'
    start = vi.fn().mockResolvedValue(undefined)
    shutdown = vi.fn().mockResolvedValue(undefined)
    setOnlineState = vi.fn()
    setManifestSyncManager = vi.fn()
    claimLeader = vi.fn()
    online = true
    flush = vi.fn()
    onLifecycleStart = vi.fn().mockImplementation(async () => {
      await this.start()
    })

    onLifecycleStop = vi.fn().mockImplementation(async () => {
      await this.shutdown()
    })
  },
}))

vi.mock('./stores/LastModifiedStore', () => ({
  LastModifiedStore: class MockLastModifiedStore {
    clear = vi.fn().mockResolvedValue(undefined)
    testStorageAvailable = vi.fn().mockResolvedValue(true)
  },
}))

vi.mock('./stores/SyncedHeadsStore', () => ({
  SyncedHeadsStore: class MockSyncedHeadsStore {
    loadSyncedHeads = vi.fn().mockResolvedValue([])
    saveSyncedHeads = vi.fn().mockResolvedValue(undefined)
    clear = vi.fn().mockResolvedValue(undefined)
  },
}))

vi.mock('./ItemOperations', () => ({
  ItemOperations: class MockItemOperations {
    constructor(public deps: { markDocumentDirty: (id: ItemId) => void }) {}
  },
}))

const mockRealtimeBus = vi.hoisted(() => ({
  itemDirtyListeners: [] as Array<(itemIds: string[]) => void>,
}))

vi.mock('./realtimeBus', () => ({
  publishRealtimeBusItemDirty: vi.fn(),
  subscribeRealtimeBusItemDirty: vi.fn((_accountId: string, listener: (itemIds: string[]) => void) => {
    mockRealtimeBus.itemDirtyListeners.push(listener)
    return () => {
      mockRealtimeBus.itemDirtyListeners = mockRealtimeBus.itemDirtyListeners.filter(l => l !== listener)
    }
  }),
}))

// The real RecoveryManager is used (backed by the in-memory store mock above) so that
// event handling can be verified end to end

vi.mock('./ManifestSyncManager', () => ({
  ManifestSyncManager: class MockManifestSyncManager {
    readonly lifecycleName = 'ManifestSyncManager'
    shutdown = vi.fn()
    onLifecycleStop = vi.fn().mockImplementation(() => {
      this.shutdown()
    })
  },
}))

const mockReadDeviceDataVersion = vi.hoisted(() => vi.fn(async () => 0))

vi.mock('./DataVersionTracker', async importOriginal => ({
  ...await importOriginal<typeof import('./DataVersionTracker')>(),
  readDeviceDataVersion: mockReadDeviceDataVersion,
}))

// ─────────────────────────────────────────────────────────────────────────────

describe('SyncWorkerContext', () => {
  let context: SyncWorkerContext
  let internalEventHub: WorkerInternalEventHub
  let clientEventHub: ClientEventHub

  beforeEach(async () => {
    vi.clearAllMocks()
    mockRealtimeBus.itemDirtyListeners = []
    const hubs = createTestEventHubs()
    clientEventHub = hubs.clientEventHub
    internalEventHub = hubs.internalEventHub

    context = new SyncWorkerContext({
      accountId: 'test-account',
      keys: createMockKeyProvider(),
      clientEventHub,
      internalEventHub,
    })
    await context.initialize()
  })

  it('marks item dirty in SnapshotManager when adapter triggers re-negotiation', () => {
    internalEventHub.emit({ type: 'renegotiationTriggered', documentId: 'test-doc-id' as DocumentId })
    expect(context.snapshotManager.markItemDirty).toHaveBeenCalledWith('test-doc-id' as ItemId, 0)
  })

  it('marks item dirty in SnapshotManager when broker reports WAL append failure', () => {
    internalEventHub.emit({ type: 'walAppendFailed', itemId: 'test-item-id' as ItemId, error: new Error('WAL write failed') })
    expect(context.snapshotManager.markItemDirty).toHaveBeenCalledWith('test-item-id' as ItemId, 0)
  })

  it('marks items dirty in SnapshotManager when WAL entries are pruned', () => {
    internalEventHub.emit({ type: 'walEntriesPruned', itemIds: ['pruned-item-1' as ItemId, 'pruned-item-2' as ItemId] })
    expect(context.snapshotManager.markItemDirty).toHaveBeenCalledWith('pruned-item-1' as ItemId, 0)
    expect(context.snapshotManager.markItemDirty).toHaveBeenCalledWith('pruned-item-2' as ItemId, 0)
  })

  it('forwards clearLocalData options to pullQueueManager and snapshotManager on shutdown without clearing storage directly', async () => {
    await context.shutdown({ clearLocalData: true })

    expect(context.pullQueueManager.shutdown).toHaveBeenCalledWith({ clearLocalData: true })
    expect(context.snapshotManager.shutdown).toHaveBeenCalledWith({ clearLocalData: true })
    expect(context.orchestrator.shutdown).toHaveBeenCalled()
    expect(context.docStore.shutdown).toHaveBeenCalled()
    expect(context.wal.clear).not.toHaveBeenCalled()
    expect(clearSyncMetadataStorage).not.toHaveBeenCalled()
    expect(context.indexStore.clear).not.toHaveBeenCalled()
    expect(context.cursorStore.clear).not.toHaveBeenCalled()
  })

  it('shuts down cleanly without clearLocalData', async () => {
    await context.shutdown()

    expect(context.pullQueueManager.shutdown).toHaveBeenCalledWith(undefined)
    expect(context.snapshotManager.shutdown).toHaveBeenCalledWith(undefined)
    expect(context.wal.clear).not.toHaveBeenCalled()
    expect(clearSyncMetadataStorage).not.toHaveBeenCalled()
    expect(context.indexStore.clear).not.toHaveBeenCalled()
    expect(context.cursorStore.clear).not.toHaveBeenCalled()
  })

  it('marks local edits dirty and announces them to other tabs', () => {
    const { deps } = context.itemOperations as unknown as { deps: { markDocumentDirty: (id: ItemId) => void } }
    deps.markDocumentDirty('edited-item' as ItemId)

    expect(context.snapshotManager.markItemDirty).toHaveBeenCalledWith('edited-item')
    expect(publishRealtimeBusItemDirty).toHaveBeenCalledWith('test-account', ['edited-item'])
  })

  it('marks items dirty when another tab announces local edits', () => {
    expect(mockRealtimeBus.itemDirtyListeners).toHaveLength(1)
    mockRealtimeBus.itemDirtyListeners[0](['tab-item-1', 'tab-item-2'])

    expect(context.snapshotManager.markItemDirty).toHaveBeenCalledWith('tab-item-1')
    expect(context.snapshotManager.markItemDirty).toHaveBeenCalledWith('tab-item-2')
    expect(publishRealtimeBusItemDirty).not.toHaveBeenCalled()
  })

  it('stops listening for cross-tab edits on shutdown', async () => {
    await context.shutdown()
    expect(mockRealtimeBus.itemDirtyListeners).toHaveLength(0)
  })

  it('forwards leaderChange to snapshotManager.setLeader', () => {
    internalEventHub.emit({ type: 'leaderChange', isLeader: true })
    expect(context.snapshotManager.setLeader).toHaveBeenCalledWith(true)

    internalEventHub.emit({ type: 'leaderChange', isLeader: false })
    expect(context.snapshotManager.setLeader).toHaveBeenCalledWith(false)
  })

  describe('manual recovery event handling', () => {
    async function createContext() {
      const { clientEventHub: ctxClientHub, internalEventHub: ctxInternalHub } = createTestEventHubs()
      const ctx = new SyncWorkerContext({
        accountId: 'test-account',
        keys: createMockKeyProvider(),
        clientEventHub: ctxClientHub,
        internalEventHub: ctxInternalHub,
      })
      await ctx.initialize()
      return { ctx, ctxInternalHub }
    }

    beforeEach(() => {
      mockRecoveryEntries.clear()
    })

    it('does not remove a manual recovery entry when itemMessageParsed is received', async () => {
      const { ctx, ctxInternalHub } = await createContext()
      await ctx.recoveryManager.quarantine(
        'item-1' as ItemId,
        'oversized',
        'Snapshot size (400 KB) exceeds 350 KB limit.',
      )

      ctxInternalHub.emit({ type: 'itemMessageParsed', itemId: 'item-1' as ItemId })
      await new Promise(resolve => setTimeout(resolve, 50))

      const entries = await ctx.recoveryManager.listRecoveryItems('test-account')
      expect(entries).toHaveLength(1)
      expect(entries[0].kind).toBe('oversized')
    })

    it('resolves pullDecryption quarantines when remoteMessagesParsed is received', async () => {
      const { ctx, ctxInternalHub } = await createContext()
      const resolveSpy = vi.spyOn(ctx.recoveryManager, 'resolveQuarantines').mockResolvedValue(undefined)

      ctxInternalHub.emit({ type: 'remoteMessagesParsed', itemId: 'item-1' as ItemId })

      expect(resolveSpy).toHaveBeenCalledWith(['item-1'], INBOUND_MESSAGE_RESOLVABLE_KINDS)
    })

    it('reports decryptionFailure events as pullDecryption', async () => {
      const { ctx, ctxInternalHub } = await createContext()
      const reportSpy = vi.spyOn(ctx.recoveryManager, 'reportDecryptionFailure').mockResolvedValue(undefined)
      const error = new Error('bad')

      ctxInternalHub.emit({ type: 'decryptionFailure', itemId: 'item-1' as ItemId, error })

      expect(reportSpy).toHaveBeenCalledWith('item-1', 'pullDecryption', error)
    })
  })

  describe('retrySave', () => {
    it('returns failure if probe testStorageAvailable throws QuotaExceededError', async () => {
      const quotaErr = new DOMException('Quota exceeded', 'QuotaExceededError')
      vi.spyOn(context.lastModifiedStore, 'testStorageAvailable').mockRejectedValueOnce(quotaErr)

      const result = await context.retrySave()
      expect(result.success).toBe(false)
      expect(result.error).toContain('still exceeded')
    })

    it('saves dirty documents, triggers renegotiation, persists timestamps, and emits quotaResolved on success', async () => {
      vi.spyOn(context.snapshotManager, 'getDirtyItemIds').mockReturnValue(['item-1' as ItemId, 'item-2' as ItemId])
      const saveDocSpy = vi.spyOn(context.docStore, 'saveDocToStorage').mockResolvedValue(true)
      const persistTimestampsSpy = vi.spyOn(context.snapshotManager, 'persistLastModified').mockResolvedValue(undefined)
      const emitSpy = vi.spyOn(context.clientEventHub, 'emit')

      const result = await context.retrySave()

      expect(result.success).toBe(true)
      expect(context.broker.unblockAllItems).toHaveBeenCalled()
      expect(context.adapter.resetReNegotiationCircuit).toHaveBeenCalled()
      expect(saveDocSpy).toHaveBeenCalledWith('item-1' as ItemId)
      expect(saveDocSpy).toHaveBeenCalledWith('item-2' as ItemId)
      expect(context.adapter.triggerReNegotiation).toHaveBeenCalled()
      expect(persistTimestampsSpy).toHaveBeenCalled()
      expect(emitSpy).toHaveBeenCalledWith({ type: 'quotaResolved' })
    })
  })

  it('wires manifestSyncManager into orchestrator on construction', () => {
    expect(context.orchestrator.setManifestSyncManager).toHaveBeenCalledWith(context.manifestSyncManager)
  })

  it('delegates claimLeader to orchestrator.claimLeader', () => {
    context.claimLeader()
    expect(context.orchestrator.claimLeader).toHaveBeenCalledTimes(1)
  })

  it('triggers wal.handleQuotaExceeded and emits quotaExceeded event when storage recovery handles quota', async () => {
    const walSpy = vi.spyOn(context.wal, 'handleQuotaExceeded').mockResolvedValue(1)
    const emitSpy = vi.spyOn(context.clientEventHub, 'emit')

    await context.storageRecoveryService.handleQuotaExceeded(new DOMException('Quota exceeded', 'QuotaExceededError'))

    expect(walSpy).toHaveBeenCalledTimes(1)
    expect(emitSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'quotaExceeded',
        message: expect.stringContaining('Storage quota exceeded'),
      })
    )
  })

  it('delegates initialize and shutdown to lifecycle manager', async () => {
    const ctx = new SyncWorkerContext({
      accountId: 'test-account-lifecycle',
      keys: createMockKeyProvider(),
      clientEventHub,
      internalEventHub,
    })
    const startSpy = vi.spyOn(ctx.lifecycle, 'start')
    const stopSpy = vi.spyOn(ctx.lifecycle, 'stop')

    await ctx.initialize()
    expect(startSpy).toHaveBeenCalledTimes(1)

    await ctx.shutdown({ clearLocalData: true })
    expect(stopSpy).toHaveBeenCalledWith({ clearLocalData: true })
  })

  describe('migrateLocalData', () => {
    function createMigratingContext(migrateLocalData: (accountId: string) => Promise<void>) {
      return new SyncWorkerContext({
        accountId: 'test-account-migrate',
        keys: createMockKeyProvider(),
        clientEventHub,
        internalEventHub,
        migrateLocalData,
      })
    }

    it('runs before any store is read or service started', async () => {
      const calls: string[] = []
      const ctx = createMigratingContext(async accountId => {
        calls.push(`migrate:${accountId}`)
      })
      vi.spyOn(ctx.indexStore, 'hasIndex').mockImplementation(async () => {
        calls.push('hasIndex')
        return false
      })
      vi.spyOn(ctx.lifecycle, 'start').mockImplementation(async () => {
        calls.push('start')
      })

      await ctx.initialize()

      expect(calls.slice(0, 3)).toEqual(['migrate:test-account-migrate', 'hasIndex', 'start'])
    })

    it('holds the account\'s migration lock while it runs', async () => {
      const request = vi.fn(async (_name: string, _options: unknown, callback: () => Promise<void>) => callback())
      vi.stubGlobal('navigator', { ...globalThis.navigator, locks: { request } })
      try {
        const migrate = vi.fn().mockResolvedValue(undefined)
        const ctx = createMigratingContext(migrate)
        vi.spyOn(ctx.lifecycle, 'start').mockResolvedValue(undefined)

        await ctx.initialize()

        expect(request).toHaveBeenCalledWith(
          'test-vault-local-data-migration-test-account-migrate',
          { mode: 'exclusive' },
          expect.any(Function),
        )
        expect(migrate).toHaveBeenCalledTimes(1)
      } finally {
        vi.unstubAllGlobals()
      }
    })

    it('opens local storage after migrating, under the same lock acquisition', async () => {
      const calls: string[] = []
      const request = vi.fn(async (_name: string, _options: unknown, callback: () => Promise<unknown>) => {
        calls.push('lock')
        const result = await callback()
        calls.push('unlock')
        return result
      })
      vi.stubGlobal('navigator', { ...globalThis.navigator, locks: { request } })
      mockOpenLocalStorage.mockImplementationOnce(async () => {
        calls.push('open')
        return { storage: { close: vi.fn().mockResolvedValue(undefined) } }
      })
      try {
        const ctx = createMigratingContext(async () => {
          calls.push('migrate')
        })
        vi.spyOn(ctx.lifecycle, 'start').mockResolvedValue(undefined)

        await ctx.initialize()

        expect(request).toHaveBeenCalledTimes(1)
        expect(calls).toEqual(['lock', 'migrate', 'open', 'unlock'])
      } finally {
        vi.unstubAllGlobals()
      }
    })

    it('creates no Repo when shut down while waiting for the lock', async () => {
      let releaseLock!: () => void
      const lockWait = new Promise<void>(resolve => {
        releaseLock = resolve
      })
      const request = vi.fn(async (_name: string, _options: unknown, callback: () => Promise<unknown>) => {
        await lockWait
        return callback()
      })
      const close = vi.fn().mockResolvedValue(undefined)
      mockOpenLocalStorage.mockResolvedValueOnce({ storage: { close } })
      vi.stubGlobal('navigator', { ...globalThis.navigator, locks: { request } })
      try {
        const ctx = createMigratingContext(vi.fn().mockResolvedValue(undefined))
        const startSpy = vi.spyOn(ctx.lifecycle, 'start')

        const initializing = ctx.initialize()
        await ctx.shutdown()
        releaseLock()

        await expect(initializing).rejects.toThrow(AbortError)
        expect(ctx.repoManager).toBeUndefined()
        expect(close).toHaveBeenCalledTimes(1)
        expect(startSpy).not.toHaveBeenCalled()
      } finally {
        vi.unstubAllGlobals()
      }
    })

    it('fails initialization without starting when it throws', async () => {
      const ctx = createMigratingContext(vi.fn().mockRejectedValue(new Error('migration failed')))
      const startSpy = vi.spyOn(ctx.lifecycle, 'start')

      await expect(ctx.initialize()).rejects.toThrow('migration failed')
      expect(startSpy).not.toHaveBeenCalled()
    })
  })

  describe('device data version gate', () => {
    function createGatedContext(options: { hasLegacyLocalData?: () => Promise<boolean> } = {}) {
      const ctx = new SyncWorkerContext({
        accountId: 'test-account-gated',
        keys: createMockKeyProvider(),
        clientEventHub,
        internalEventHub,
        minDataVersion: 1,
        hasLegacyLocalData: options.hasLegacyLocalData,
      })
      vi.spyOn(ctx.lifecycle, 'start').mockResolvedValue(undefined)
      return ctx
    }

    it('refuses to start a device with local data below the minimum level', async () => {
      mockReadDeviceDataVersion.mockResolvedValueOnce(0)
      const emitSpy = vi.spyOn(clientEventHub, 'emit')
      const migrate = vi.fn()
      const ctx = new SyncWorkerContext({
        accountId: 'test-account-gated',
        keys: createMockKeyProvider(),
        clientEventHub,
        internalEventHub,
        minDataVersion: 1,
        migrateLocalData: migrate,
      })
      vi.spyOn(ctx.indexStore, 'hasIndex').mockResolvedValue(true)
      const startSpy = vi.spyOn(ctx.lifecycle, 'start')

      await expect(ctx.initialize()).rejects.toThrow(MigrationRequiredError)

      expect(emitSpy).toHaveBeenCalledWith({ type: 'migrationRequired', reason: 'device' })
      expect(migrate).not.toHaveBeenCalled()
      expect(startSpy).not.toHaveBeenCalled()
    })

    it('refuses to start a device whose only data is in a legacy layout', async () => {
      mockReadDeviceDataVersion.mockResolvedValueOnce(0)
      const hasLegacyLocalData = vi.fn().mockResolvedValue(true)
      const ctx = createGatedContext({ hasLegacyLocalData })

      await expect(ctx.initialize()).rejects.toThrow(MigrationRequiredError)
      expect(hasLegacyLocalData).toHaveBeenCalledWith('test-account-gated')
    })

    it('starts a device without any data for the account', async () => {
      mockReadDeviceDataVersion.mockResolvedValueOnce(0)
      const ctx = createGatedContext({ hasLegacyLocalData: vi.fn().mockResolvedValue(false) })

      await ctx.initialize()

      expect(ctx.lifecycle.start).toHaveBeenCalledTimes(1)
    })

    it('starts a device at the minimum level', async () => {
      mockReadDeviceDataVersion.mockResolvedValueOnce(1)
      const ctx = createGatedContext()
      vi.spyOn(ctx.indexStore, 'hasIndex').mockResolvedValue(true)

      await ctx.initialize()

      expect(ctx.lifecycle.start).toHaveBeenCalledTimes(1)
    })

    it('does not check the level without a minimum', async () => {
      const ctx = new SyncWorkerContext({
        accountId: 'test-account-ungated',
        keys: createMockKeyProvider(),
        clientEventHub,
        internalEventHub,
      })
      await ctx.initialize()
      expect(mockReadDeviceDataVersion).not.toHaveBeenCalled()
    })
  })

  describe('snapshot format upgrade', () => {
    it('is off unless the app opts in', () => {
      expect(context.snapshotFormatUpgrade).toBeNull()
    })

    it('is created when the app opts in', async () => {
      const ctx = new SyncWorkerContext({
        accountId: 'test-account-upgrade',
        keys: createMockKeyProvider(),
        clientEventHub,
        internalEventHub,
        upgradeSnapshotFormat: true,
      })
      await ctx.initialize()
      expect(ctx.snapshotFormatUpgrade).toBeInstanceOf(SnapshotFormatUpgrade)
    })
  })

  it('registers expected services in lifecycle manager in correct order', () => {
    const serviceNames = context.lifecycle.getRegisteredServiceNames()
    expect(serviceNames).toEqual([
      'RepoManager',
      'VaultNetworkAdapter',
      'SyncMessageBroker',
      'StorageRecoveryService',
      'IndexManager',
      'RecoveryManager',
      'DocStore',
      'SnapshotManager',
      'SyncedHeads',
      'PullQueueManager',
      'ManifestSyncManager',
      'SyncOrchestrator',
    ])
  })

  it('initializes apiClient with refreshAuthToken when provided in config', async () => {
    const mockRefresh = vi.fn().mockResolvedValue('token-123')
    const ctx = new SyncWorkerContext({
      accountId: 'test-account-refresh',
      keys: createMockKeyProvider(),
      clientEventHub,
      internalEventHub,
      refreshAuthToken: mockRefresh,
    })

    expect((ctx.apiClient as any).refreshAuth).toBe(mockRefresh)
  })
})


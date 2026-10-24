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
import { LocalCipher, LocalKeyUnavailableError } from './localEncryption/LocalCipher'
import { toDocumentIdFromItemId } from './utils/automerge'
import { DSK_KEY } from './localEncryption/openLocalStorage'
import { Keyring } from '../../api/Keyring'
import { generateVaultKey } from '../../api/crypto'

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

// Shared by every IndexStore instance, so tests can set it before the context creates its own
const mockHasIndex = vi.hoisted(() => vi.fn(async () => false))

vi.mock('./stores/IndexStore', () => ({
  IndexStore: class MockIndexStore {
    constructor(readonly accountId: string, readonly options: { cipher?: unknown } = {}) {}
    clear = vi.fn().mockResolvedValue(undefined)
    hasIndex = mockHasIndex
    getIndex = vi.fn().mockResolvedValue(null)
  },
}))

const mockSealedWalLength = vi.hoisted(() => vi.fn(async () => 0))

vi.mock('./SyncWriteAheadLog', () => ({
  SyncWriteAheadLog: class MockSyncWriteAheadLog {
    static getSealedStorage = () => ({ length: mockSealedWalLength })
    constructor(readonly accountId: string, readonly hub?: unknown, readonly options: { cipher?: unknown } = {}) {}
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
    hasDataInStorage = vi.fn().mockResolvedValue(true)
    isLocallyUnreadable?: (documentId: string) => boolean
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
    getBlockedItemIds = vi.fn().mockReturnValue([])
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
    setHeadsValidator = vi.fn()
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

const mockOpenLocalStorage = vi.hoisted(() => vi.fn(async (_: unknown): Promise<any> => ({
  mode: 'plaintext',
  retired: false,
  storage: { close: vi.fn().mockResolvedValue(undefined) },
})))

vi.mock('./localEncryption/openLocalStorage', async importOriginal => ({
  ...await importOriginal<typeof import('./localEncryption/openLocalStorage')>(),
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
    sync = vi.fn().mockResolvedValue({ added: [], success: true })
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
    mockHasIndex.mockResolvedValue(false)
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
    expect(context.services.snapshotManager.markItemDirty).toHaveBeenCalledWith('test-doc-id' as ItemId, 0)
  })

  it('marks item dirty in SnapshotManager when broker reports WAL append failure', () => {
    internalEventHub.emit({ type: 'walAppendFailed', itemId: 'test-item-id' as ItemId, error: new Error('WAL write failed') })
    expect(context.services.snapshotManager.markItemDirty).toHaveBeenCalledWith('test-item-id' as ItemId, 0)
  })

  it('marks items dirty in SnapshotManager when WAL entries are pruned', () => {
    internalEventHub.emit({ type: 'walEntriesPruned', itemIds: ['pruned-item-1' as ItemId, 'pruned-item-2' as ItemId] })
    expect(context.services.snapshotManager.markItemDirty).toHaveBeenCalledWith('pruned-item-1' as ItemId, 0)
    expect(context.services.snapshotManager.markItemDirty).toHaveBeenCalledWith('pruned-item-2' as ItemId, 0)
  })

  it('forwards clearLocalData options to pullQueueManager and snapshotManager on shutdown without clearing storage directly', async () => {
    await context.shutdown({ clearLocalData: true })

    expect(context.services.pullQueueManager.shutdown).toHaveBeenCalledWith({ clearLocalData: true })
    expect(context.services.snapshotManager.shutdown).toHaveBeenCalledWith({ clearLocalData: true })
    expect(context.services.orchestrator.shutdown).toHaveBeenCalled()
    expect(context.services.docStore.shutdown).toHaveBeenCalled()
    expect(context.services.wal.clear).not.toHaveBeenCalled()
    expect(clearSyncMetadataStorage).not.toHaveBeenCalled()
    expect(context.services.indexStore.clear).not.toHaveBeenCalled()
    expect(context.services.cursorStore.clear).not.toHaveBeenCalled()
  })

  it('shuts down cleanly without clearLocalData', async () => {
    await context.shutdown()

    expect(context.services.pullQueueManager.shutdown).toHaveBeenCalledWith(undefined)
    expect(context.services.snapshotManager.shutdown).toHaveBeenCalledWith(undefined)
    expect(context.services.wal.clear).not.toHaveBeenCalled()
    expect(clearSyncMetadataStorage).not.toHaveBeenCalled()
    expect(context.services.indexStore.clear).not.toHaveBeenCalled()
    expect(context.services.cursorStore.clear).not.toHaveBeenCalled()
  })

  it('marks local edits dirty and announces them to other tabs', () => {
    const { deps } = context.services.itemOperations as unknown as { deps: { markDocumentDirty: (id: ItemId) => void } }
    deps.markDocumentDirty('edited-item' as ItemId)

    expect(context.services.snapshotManager.markItemDirty).toHaveBeenCalledWith('edited-item')
    expect(publishRealtimeBusItemDirty).toHaveBeenCalledWith('test-account', ['edited-item'])
  })

  it('marks items dirty when another tab announces local edits', () => {
    expect(mockRealtimeBus.itemDirtyListeners).toHaveLength(1)
    mockRealtimeBus.itemDirtyListeners[0](['tab-item-1', 'tab-item-2'])

    expect(context.services.snapshotManager.markItemDirty).toHaveBeenCalledWith('tab-item-1')
    expect(context.services.snapshotManager.markItemDirty).toHaveBeenCalledWith('tab-item-2')
    expect(publishRealtimeBusItemDirty).not.toHaveBeenCalled()
  })

  it('stops listening for cross-tab edits on shutdown', async () => {
    await context.shutdown()
    expect(mockRealtimeBus.itemDirtyListeners).toHaveLength(0)
  })

  it('forwards leaderChange to snapshotManager.setLeader', () => {
    internalEventHub.emit({ type: 'leaderChange', isLeader: true })
    expect(context.services.snapshotManager.setLeader).toHaveBeenCalledWith(true)

    internalEventHub.emit({ type: 'leaderChange', isLeader: false })
    expect(context.services.snapshotManager.setLeader).toHaveBeenCalledWith(false)
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
      await ctx.services.recoveryManager.quarantine(
        'item-1' as ItemId,
        'oversized',
        'Snapshot size (400 KB) exceeds 350 KB limit.',
      )

      ctxInternalHub.emit({ type: 'itemMessageParsed', itemId: 'item-1' as ItemId })
      await new Promise(resolve => setTimeout(resolve, 50))

      const entries = await ctx.services.recoveryManager.listRecoveryItems('test-account')
      expect(entries).toHaveLength(1)
      expect(entries[0].kind).toBe('oversized')
    })

    it('resolves pullDecryption quarantines when remoteMessagesParsed is received', async () => {
      const { ctx, ctxInternalHub } = await createContext()
      const resolveSpy = vi.spyOn(ctx.services.recoveryManager, 'resolveQuarantines').mockResolvedValue(undefined)

      ctxInternalHub.emit({ type: 'remoteMessagesParsed', itemId: 'item-1' as ItemId })

      expect(resolveSpy).toHaveBeenCalledWith(['item-1'], INBOUND_MESSAGE_RESOLVABLE_KINDS)
    })

    it('reports decryptionFailure events as pullDecryption', async () => {
      const { ctx, ctxInternalHub } = await createContext()
      const reportSpy = vi.spyOn(ctx.services.recoveryManager, 'reportDecryptionFailure').mockResolvedValue(undefined)
      const error = new Error('bad')

      ctxInternalHub.emit({ type: 'decryptionFailure', itemId: 'item-1' as ItemId, error })

      expect(reportSpy).toHaveBeenCalledWith('item-1', 'pullDecryption', error)
    })
  })

  describe('retrySave', () => {
    it('returns failure if probe testStorageAvailable throws QuotaExceededError', async () => {
      const quotaErr = new DOMException('Quota exceeded', 'QuotaExceededError')
      vi.spyOn(context.services.lastModifiedStore, 'testStorageAvailable').mockRejectedValueOnce(quotaErr)

      const result = await context.retrySave()
      expect(result.success).toBe(false)
      expect(result.error).toContain('still exceeded')
    })

    it('saves dirty documents, triggers renegotiation, persists timestamps, and emits quotaResolved on success', async () => {
      vi.spyOn(context.services.snapshotManager, 'getDirtyItemIds').mockReturnValue(['item-1' as ItemId, 'item-2' as ItemId])
      const saveDocSpy = vi.spyOn(context.services.docStore, 'saveDocToStorage').mockResolvedValue(true)
      const persistTimestampsSpy = vi.spyOn(context.services.snapshotManager, 'persistLastModified').mockResolvedValue(undefined)
      const emitSpy = vi.spyOn(context.clientEventHub, 'emit')

      const result = await context.retrySave()

      expect(result.success).toBe(true)
      expect(context.services.broker.unblockAllItems).toHaveBeenCalled()
      expect(context.services.adapter.resetReNegotiationCircuit).toHaveBeenCalled()
      expect(saveDocSpy).toHaveBeenCalledWith('item-1' as ItemId)
      expect(saveDocSpy).toHaveBeenCalledWith('item-2' as ItemId)
      expect(context.services.adapter.triggerReNegotiation).toHaveBeenCalled()
      expect(persistTimestampsSpy).toHaveBeenCalled()
      expect(emitSpy).toHaveBeenCalledWith({ type: 'quotaResolved' })
    })
  })

  it('wires manifestSyncManager into orchestrator on construction', () => {
    expect(context.services.orchestrator.setManifestSyncManager).toHaveBeenCalledWith(context.services.manifestSyncManager)
  })

  it('delegates claimLeader to orchestrator.claimLeader', () => {
    context.claimLeader()
    expect(context.services.orchestrator.claimLeader).toHaveBeenCalledTimes(1)
  })

  it('triggers wal.handleQuotaExceeded and emits quotaExceeded event when storage recovery handles quota', async () => {
    const walSpy = vi.spyOn(context.services.wal, 'handleQuotaExceeded').mockResolvedValue(1)
    const emitSpy = vi.spyOn(context.clientEventHub, 'emit')

    await context.services.storageRecoveryService.handleQuotaExceeded(new DOMException('Quota exceeded', 'QuotaExceededError'))

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

  describe('local encryption', () => {
    function createSealingContext() {
      const localKeys = { activeVersion: '1' } as any
      const ctx = new SyncWorkerContext({
        accountId: 'test-account-sealed',
        keys: createMockKeyProvider(),
        localKeys,
        clientEventHub,
        internalEventHub,
        upgradeLocalEncryption: true,
        randomDataKeys: true,
      })
      vi.spyOn(ctx.lifecycle, 'start').mockResolvedValue(undefined)
      return { ctx, localKeys }
    }

    it('opens local storage under the local data lock, with the keys and what the server said about them', async () => {
      const request = vi.fn(async (_name: string, _options: unknown, callback: () => Promise<unknown>) => callback())
      vi.stubGlobal('navigator', { ...globalThis.navigator, locks: { request } })
      try {
        const { ctx, localKeys } = createSealingContext()

        await ctx.initialize()

        expect(request).toHaveBeenCalledWith(
          'test-vault-local-data-migration-test-account-sealed',
          { mode: 'exclusive' },
          expect.any(Function),
        )
        expect(mockOpenLocalStorage).toHaveBeenCalledWith(expect.objectContaining({
          accountId: 'test-account-sealed',
          upgradeLocalEncryption: true,
          keys: localKeys,
          randomDataKeys: true,
        }))
      } finally {
        vi.unstubAllGlobals()
      }
    })

    it('seals the index and WAL with the device key when storage is sealed', async () => {
      const cipher = { seal: vi.fn() }
      mockOpenLocalStorage.mockResolvedValueOnce({
        mode: 'sealed', retired: true, cipher, storage: { close: vi.fn() },
      })
      const { ctx } = createSealingContext()

      await ctx.initialize()

      expect((ctx.services.indexStore as any).options.cipher).toBe(cipher)
      expect((ctx.services.wal as any).options.cipher).toBe(cipher)
      expect(ctx.localStorageState).toEqual({ mode: 'sealed', retired: true })
    })

    it('asks the app to stop other tabs before retiring the plaintext stores', async () => {
      const { ctx } = createSealingContext()
      const emitSpy = vi.spyOn(clientEventHub, 'emit')
      await ctx.initialize()
      const options = mockOpenLocalStorage.mock.lastCall![0] as { onRetiring: () => void }

      options.onRetiring()

      expect(emitSpy).toHaveBeenCalledWith({ type: 'retiringLegacyStores', accountId: 'test-account-sealed' })
    })

    it('reports local data it cannot open, with the unpushed change count, and does not start', async () => {
      mockOpenLocalStorage.mockRejectedValueOnce(new LocalKeyUnavailableError('2'))
      mockSealedWalLength.mockResolvedValueOnce(3)
      const { ctx } = createSealingContext()
      const emitSpy = vi.spyOn(clientEventHub, 'emit')

      await expect(ctx.initialize()).rejects.toBeInstanceOf(LocalKeyUnavailableError)

      expect(emitSpy).toHaveBeenCalledWith({ type: 'localDataUnavailable', kver: '2', unpushedChanges: 3 })
      expect(ctx.lifecycle.start).not.toHaveBeenCalled()
      expect(() => ctx.services).toThrow()
    })
  })

  describe('device level while local data is being sealed', () => {
    async function createTrackedContext(local: { mode: string, retired: boolean }) {
      mockOpenLocalStorage.mockResolvedValueOnce({ ...local, storage: { close: vi.fn() } })
      const ctx = new SyncWorkerContext({
        accountId: 'test-account-level',
        keys: createMockKeyProvider(),
        clientEventHub,
        internalEventHub,
        upgradeLocalEncryption: true,
        sealedDataVersion: 3,
      })
      vi.spyOn(ctx.lifecycle, 'start').mockResolvedValue(undefined)
      await ctx.initialize()
      return (ctx.services.dataVersionTracker as unknown as { deps: { maxDeviceVersion: () => number } }).deps.maxDeviceVersion
    }

    it.each([
      ['plaintext storage', { mode: 'plaintext', retired: false }, 2],
      ['sealed storage with plaintext stores left', { mode: 'sealed', retired: false }, 2],
      ['sealed storage with the plaintext stores retired', { mode: 'sealed', retired: true }, Number.POSITIVE_INFINITY],
    ])('caps the device level on %s', async (_case, local, expected) => {
      const maxDeviceVersion = await createTrackedContext(local)

      expect(maxDeviceVersion()).toBe(expected)
    })
  })

  describe('rewrapDeviceKey', () => {
    async function createSealedContext() {
      const keyring = new Keyring()
      keyring.replace(new Map([['1', await generateVaultKey()]]), '1')
      const { cipher, wrap } = await LocalCipher.create(keyring, 'test-account-rewrap')
      const meta = new Map<string, unknown>([[DSK_KEY, wrap]])
      const storage = {
        close: vi.fn(),
        getMeta: vi.fn(async (key: string) => meta.get(key)),
        putMeta: vi.fn(async (key: string, value: unknown) => {
          meta.set(key, value)
        }),
      }
      mockOpenLocalStorage.mockResolvedValueOnce({ mode: 'sealed', retired: true, cipher, storage })
      const ctx = new SyncWorkerContext({
        accountId: 'test-account-rewrap',
        keys: createMockKeyProvider(),
        localKeys: keyring,
        clientEventHub,
        internalEventHub,
        upgradeLocalEncryption: true,
      })
      vi.spyOn(ctx.lifecycle, 'start').mockResolvedValue(undefined)
      await ctx.initialize()
      return { ctx, keyring, cipher, meta, storage }
    }

    it('wraps the same device key with the newly active data key', async () => {
      const { ctx, keyring, cipher, meta } = await createSealedContext()
      const record = await cipher.seal({ store: 'index' }, new Uint8Array([1, 2, 3]))
      keyring.addKey('2', await generateVaultKey())
      keyring.setActiveVersion('2')

      await ctx.rewrapDeviceKey()

      const rewrapped = meta.get(DSK_KEY) as { kver: string }
      expect(rewrapped.kver).toBe('2')
      const reopened = await LocalCipher.unwrap(rewrapped, keyring, 'test-account-rewrap')
      expect(await reopened.open({ store: 'index' }, record)).toEqual(new Uint8Array([1, 2, 3]))
    })

    it('leaves a wrap that already uses the active key', async () => {
      const { ctx, storage } = await createSealedContext()

      await ctx.rewrapDeviceKey()

      expect(storage.putMeta).not.toHaveBeenCalled()
    })

    it('logs a failure rather than failing the rotation, keeping the old wrap', async () => {
      const { ctx, keyring, storage, meta } = await createSealedContext()
      const wrap = meta.get(DSK_KEY)
      keyring.replace(new Map([['2', await generateVaultKey()]]), '2')
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      await expect(ctx.rewrapDeviceKey()).resolves.toBeUndefined()

      expect(storage.putMeta).not.toHaveBeenCalled()
      expect(meta.get(DSK_KEY)).toBe(wrap)
      expect(errorSpy).toHaveBeenCalled()
    })

    it('does nothing on plaintext storage', async () => {
      await expect(context.rewrapDeviceKey()).resolves.toBeUndefined()
    })
  })

  describe('unreadable local documents', () => {
    async function createContextWithOpenFailures() {
      const ctx = new SyncWorkerContext({
        accountId: 'test-account-unreadable',
        keys: createMockKeyProvider(),
        clientEventHub,
        internalEventHub,
        upgradeLocalEncryption: true,
      })
      vi.spyOn(ctx.lifecycle, 'start').mockResolvedValue(undefined)
      await ctx.initialize()
      const { onOpenFailure } = mockOpenLocalStorage.mock.lastCall![0] as {
        onOpenFailure: (key: string[], error: unknown) => void
      }
      return { ctx, onOpenFailure }
    }

    it('quarantines a document once, however many of its chunks fail', async () => {
      const { ctx, onOpenFailure } = await createContextWithOpenFailures()
      const reportSpy = vi.spyOn(ctx.services.recoveryManager, 'reportDecryptionFailure').mockResolvedValue(undefined)
      const error = new Error('bad tag')

      onOpenFailure(['doc-1', 'snapshot', 'heads-1'], error)
      onOpenFailure(['doc-1', 'incremental', 'change-1'], error)

      expect(reportSpy).toHaveBeenCalledTimes(1)
      expect(reportSpy).toHaveBeenCalledWith('doc-1', 'localDecryption', error)
      expect(ctx.services.docStore.isLocallyUnreadable?.('doc-1' as DocumentId)).toBe(true)
      expect(ctx.services.docStore.isLocallyUnreadable?.('doc-2' as DocumentId)).toBe(false)
    })

    it('ignores the storage ID record, which is not a document', async () => {
      const { ctx, onOpenFailure } = await createContextWithOpenFailures()
      const reportSpy = vi.spyOn(ctx.services.recoveryManager, 'reportDecryptionFailure').mockResolvedValue(undefined)

      onOpenFailure(['storage-adapter-id'], new Error('bad tag'))

      expect(reportSpy).not.toHaveBeenCalled()
    })

    it('replaces an unreadable document with the server\'s copy', async () => {
      const { ctx, onOpenFailure } = await createContextWithOpenFailures()
      vi.spyOn(ctx.services.recoveryManager, 'reportDecryptionFailure').mockResolvedValue(undefined)
      const unquarantine = vi.spyOn(ctx.services.recoveryManager, 'unquarantine').mockResolvedValue(undefined)
      const removeRange = vi.fn().mockResolvedValue(undefined)
      vi.mocked(ctx.services.repoManager.getStorage).mockReturnValue({ removeRange } as any)
      ctx.services.repo = { delete: vi.fn() } as any
      const itemId = 'item-unreadable' as ItemId
      const documentId = toDocumentIdFromItemId(itemId)
      onOpenFailure([documentId, 'snapshot', 'heads-1'], new Error('bad tag'))

      await ctx.replaceFromServer(itemId)

      expect(ctx.services.repo.delete).toHaveBeenCalledWith(documentId)
      expect(removeRange).toHaveBeenCalledWith([documentId])
      expect(ctx.services.manifestSyncManager.sync).toHaveBeenCalledWith(true)
      expect(unquarantine).toHaveBeenCalledWith(itemId)
      expect(ctx.services.docStore.isLocallyUnreadable?.(documentId)).toBe(false)
    })

    it('keeps the item quarantined when the server has no copy to replace it with', async () => {
      const { ctx } = await createContextWithOpenFailures()
      const unquarantine = vi.spyOn(ctx.services.recoveryManager, 'unquarantine').mockResolvedValue(undefined)
      ctx.services.repo = { delete: vi.fn() } as any
      vi.mocked(ctx.services.docStore.hasDataInStorage).mockResolvedValueOnce(false)

      await expect(ctx.replaceFromServer('item-gone' as ItemId)).rejects.toThrow(/could not be downloaded/)

      expect(unquarantine).not.toHaveBeenCalled()
    })
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
      mockHasIndex.mockImplementation(async () => {
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
        return { mode: 'plaintext', retired: false, storage: { close: vi.fn().mockResolvedValue(undefined) } }
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
      mockOpenLocalStorage.mockResolvedValueOnce({ mode: 'plaintext', retired: false, storage: { close } })
      vi.stubGlobal('navigator', { ...globalThis.navigator, locks: { request } })
      try {
        const ctx = createMigratingContext(vi.fn().mockResolvedValue(undefined))
        const startSpy = vi.spyOn(ctx.lifecycle, 'start')

        const initializing = ctx.initialize()
        await ctx.shutdown()
        releaseLock()

        await expect(initializing).rejects.toThrow(AbortError)
        expect(() => ctx.services).toThrow()
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
      mockHasIndex.mockResolvedValue(true)
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
      mockHasIndex.mockResolvedValue(true)

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
      expect(context.services.snapshotFormatUpgrade).toBeNull()
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
      expect(ctx.services.snapshotFormatUpgrade).toBeInstanceOf(SnapshotFormatUpgrade)
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


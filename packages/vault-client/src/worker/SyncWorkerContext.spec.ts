import { SyncWorkerContext } from './SyncWorkerContext'
import { SyncApiClient } from './SyncApiClient'
import { INBOUND_MESSAGE_RESOLVABLE_KINDS } from './RecoveryManager'
import { ClientEventHub } from './SyncEventHub'
import { createFakeRealtimeBus, createMockKeyProvider, type FakeRealtimeBus } from './__test__/testUtils'
import { spyOnExports } from '../../test/moduleMocks'
import type { ItemId } from '@vault/shared'
import type { DocumentId } from '@automerge/automerge-repo/slim'
import { clearSyncMetadataStorage } from '../shared/syncMetadataStorage'
import { MigrationRequiredError } from './DataVersionTracker'
import { SnapshotFormatUpgrade } from './SnapshotFormatUpgrade'
import { AbortError } from '../utils/abort'
import { SYNC_TIMEOUTS } from '../shared/syncConfig'
import * as syncResetModule from './syncReset'
import { LocalCipher, LocalKeyUnavailableError } from './localEncryption/LocalCipher'
import { toDocumentIdFromItemId } from './utils/automerge'
import { DSK_KEY } from './localEncryption/openLocalStorage'
import type { ChangeOutboxDeps } from './ChangeOutbox'
import type { GapHealerDeps } from './GapHealer'
import type { SyncLogPullerDeps } from './SyncLogPuller'
import type { SyncOrchestratorDeps } from './SyncOrchestrator'
import type { SyncPollerDeps } from './SyncPoller'
import type { ItemRecoveryServiceDeps } from './ItemRecoveryService'
import { Keyring } from '../keys/Keyring'
import { generateVaultKey } from '../keys/crypto'
import * as manualRecoveryStoreModule from '../shared/manualRecoveryStore'
import * as syncMetadataStorageModule from '../shared/syncMetadataStorage'
import * as indexStoreModule from './stores/IndexStore'
import * as syncLogDatabaseModule from './stores/SyncLogDatabase'
import * as docStoreModule from './docStore'
import * as automergeRepoManager from './AutomergeRepoManager'
import * as snapshotManagerModule from './SnapshotManager'
import * as syncOrchestrator from './SyncOrchestrator'
import * as itemOperationsModule from './ItemOperations'
import * as realtimeBusModule from './RealtimeBus'
import * as manifestSyncManagerModule from './ManifestSyncManager'
import * as openLocalStorageModule from './localEncryption/openLocalStorage'
import * as dataVersionTrackerModule from './DataVersionTracker'

// ── Internalized store mocks ─────────────────────────────────────────────────

const mockRecoveryEntries = new Map<string, any>()

// Shared by every IndexStore instance, so tests can set it before the context creates its own
const mockHasIndex = vi.fn(async () => false)

const mockPendingCount = vi.fn(async () => 0)

const mockOpenLocalStorage = vi.fn(async (_: unknown): Promise<any> => ({
  mode: 'plaintext',
  retired: false,
  storage: { close: vi.fn().mockResolvedValue(undefined) },
}))

// ── Context-owned manager mocks ──────────────────────────────────────────────

/** The bus the latest context created */
let realtimeBus: FakeRealtimeBus

// The real RecoveryManager is used (backed by the in-memory store mock above) so that
// event handling can be verified end to end

const mockReadDeviceDataVersion = vi.fn(async () => 0)

/** The cap the context gave its data version tracker */
function readMaxDeviceVersion(ctx: SyncWorkerContext): () => Promise<number> {
  return depsOf<{ maxDeviceVersion: () => Promise<number> }>(ctx.services.dataVersionTracker).maxDeviceVersion
}

/** The dependencies the context gave one of the mocked components */
function depsOf<T>(component: unknown): T {
  return (component as { deps: T }).deps
}

// ─────────────────────────────────────────────────────────────────────────────

beforeEach(() => {
  spyOnExports(manualRecoveryStoreModule, {
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
  })
  spyOnExports(syncMetadataStorageModule, {
    clearSyncMetadataStorage: vi.fn().mockResolvedValue(undefined),
  })
  spyOnExports(indexStoreModule, {
    IndexStore: class MockIndexStore {
      constructor(readonly accountId: string, readonly options: { cipher?: unknown } = {}) {}
      clear = vi.fn().mockResolvedValue(undefined)
      hasIndex = mockHasIndex
      getIndex = vi.fn().mockResolvedValue(null)
      testStorageAvailable = vi.fn().mockResolvedValue(true)
    },
  })
  spyOnExports(syncLogDatabaseModule, {
    SyncLogDatabase: class MockSyncLogDatabase {
      static countPending = mockPendingCount
      get = vi.fn().mockResolvedValue(undefined)
      getAll = vi.fn().mockResolvedValue([])
      put = vi.fn().mockResolvedValue(undefined)
      update = vi.fn().mockResolvedValue(undefined)
      delete = vi.fn().mockResolvedValue(undefined)
      deleteIf = vi.fn().mockResolvedValue(undefined)
      close = vi.fn().mockResolvedValue(undefined)
    },
  })
  spyOnExports(docStoreModule, {
    AutomergeDocStore: class MockAutomergeDocStore {
      shutdown = vi.fn().mockResolvedValue(undefined)
      saveDocToStorage = vi.fn().mockResolvedValue(undefined)
      readItemSnapshot = vi.fn().mockResolvedValue(null)
      hasDataInStorage = vi.fn().mockResolvedValue(true)
      constructor(readonly deps: { isLocallyUnreadable: (documentId: string) => boolean }) {}
    },
    AutomergeIndexManager: class MockAutomergeIndexManager {
      ensureIndexDocument = vi.fn().mockResolvedValue(undefined)
      addItemIds = vi.fn()
      getMetadata = vi.fn().mockResolvedValue({})
      close = vi.fn()
    },
  })
  spyOnExports(automergeRepoManager, {
    AutomergeRepoManager: class MockAutomergeRepoManager {
      repo = {} /* mock Repo */
      storage = { has: vi.fn().mockResolvedValue(false), removeRange: vi.fn().mockResolvedValue(undefined) }
      close = vi.fn().mockResolvedValue(undefined)
    },
  })
  spyOnExports(snapshotManagerModule, {
    SnapshotManager: class MockSnapshotManager {
      schedule = {
        markItemDirty: vi.fn(),
        getDirtyItemIds: vi.fn().mockReturnValue([]),
      }

      readonly state: unknown

      constructor(readonly deps: { state: unknown }) {
        this.state = deps.state
      }

      load = vi.fn().mockResolvedValue(undefined)
      shutdown = vi.fn().mockResolvedValue(undefined)
      flushPendingSnapshots = vi.fn().mockResolvedValue({ persisted: 0, total: 0 })
      onLeaderChange = vi.fn()
      pushDue = vi.fn().mockResolvedValue({ persisted: 0, total: 0, success: true })
    },
  })
  spyOnExports(syncOrchestrator, {
    SyncOrchestrator: class MockOrchestrator {
      start = vi.fn().mockResolvedValue(undefined)
      shutdown = vi.fn().mockResolvedValue(undefined)
      onOnlineStateChange = vi.fn()
      constructor(readonly deps: SyncOrchestratorDeps) {}
      claimLeader = vi.fn(async () => {
        this.deps.session.setLeader(true)
        return true
      })

      followVisibleTab = vi.fn()

      settleLeadership = vi.fn(async () => this.deps.session.isLeader)
      flush = vi.fn()
      onForeground = vi.fn()
      onActivity = vi.fn()
      onSnapshotDue = vi.fn()
      pollNow = vi.fn().mockResolvedValue(undefined)
      syncManifest = vi.fn().mockResolvedValue({ added: [], success: true, fetchedManifest: true })
      isAuthPaused = false
    },
  })
  spyOnExports(itemOperationsModule, {
    ItemOperations: class MockItemOperations {
      constructor(public deps: { markDocumentDirty: (id: ItemId) => void }) {}
    },
  })
  spyOnExports(realtimeBusModule, {
    RealtimeBus: class MockRealtimeBus {
      constructor() {
        realtimeBus = createFakeRealtimeBus()
        return realtimeBus.bus
      }
    },
  })
  spyOnExports(manifestSyncManagerModule, {
    ManifestSyncManager: class MockManifestSyncManager {
      shutdown = vi.fn()
      runPhase = vi.fn().mockResolvedValue(null)
    },
  })
  spyOnExports(openLocalStorageModule, {
    openLocalStorage: mockOpenLocalStorage,
  })
  spyOnExports(dataVersionTrackerModule, {
    readDeviceDataVersion: mockReadDeviceDataVersion,
  })
})

describe('SyncWorkerContext', () => {
  let context: SyncWorkerContext
  let clientEventHub: ClientEventHub

  beforeEach(async () => {
    vi.clearAllMocks()
    mockHasIndex.mockResolvedValue(false)
    clientEventHub = new ClientEventHub()

    context = new SyncWorkerContext({
      accountId: 'test-account',
      keys: createMockKeyProvider(),
      clientEventHub,
      apiClient: new SyncApiClient(),
    })
    await context.initialize()
  })

  it('marks items dirty at once when a change can only reach the server in a snapshot', () => {
    depsOf<ChangeOutboxDeps>(context.services.changeOutbox).requestSnapshot('oversized-item' as ItemId)
    expect(context.services.snapshotManager.schedule.markItemDirty).toHaveBeenCalledWith('oversized-item' as ItemId, 0)
  })

  it('reports poll results and pull retries to the status manager', () => {
    const pollSpy = vi.spyOn(context.statusManager, 'handlePollResult')
    const degradedSpy = vi.spyOn(context.statusManager, 'setDegradedPull')
    depsOf<SyncOrchestratorDeps>(context.services.orchestrator).onPollResult!('failure')
    depsOf<GapHealerDeps>(context.services.gapHealer).onHealingChange!(true)
    expect(pollSpy).toHaveBeenCalledWith('failure')
    expect(degradedSpy).toHaveBeenCalledWith(true)
  })

  it('forwards clearLocalData options to the puller and the item records on shutdown without clearing storage directly', async () => {
    const pullerShutdown = vi.spyOn(context.services.puller, 'shutdown')
    const stateShutdown = vi.spyOn(context.services.itemSyncState, 'shutdown')
    await context.shutdown({ clearLocalData: true })

    expect(pullerShutdown).toHaveBeenCalledWith({ clearLocalData: true })
    expect(stateShutdown).toHaveBeenCalledWith({ clearLocalData: true })
    expect(context.services.snapshotManager.shutdown).toHaveBeenCalled()
    expect(context.services.orchestrator.shutdown).toHaveBeenCalled()
    expect(context.services.docStore.shutdown).toHaveBeenCalled()
    expect(clearSyncMetadataStorage).not.toHaveBeenCalled()
    expect(context.services.indexStore.clear).not.toHaveBeenCalled()
  })

  it('loads the item records with the log state, and only there, at start and on promotion', async () => {
    const { snapshotManager } = context.services
    const loadsAtStart = vi.mocked(snapshotManager.load).mock.calls.length
    expect(loadsAtStart).toBeGreaterThanOrEqual(1)

    await depsOf<SyncLogPullerDeps>(context.services.puller).onLoad!()
    depsOf<SyncOrchestratorDeps>(context.services.orchestrator).onLeaderChange!(true)

    expect(snapshotManager.load).toHaveBeenCalledTimes(loadsAtStart + 1)
    expect(snapshotManager.onLeaderChange).toHaveBeenCalled()
  })

  it('shuts down cleanly without clearLocalData', async () => {
    const pullerShutdown = vi.spyOn(context.services.puller, 'shutdown')
    const stateShutdown = vi.spyOn(context.services.itemSyncState, 'shutdown')
    await context.shutdown()

    expect(pullerShutdown).toHaveBeenCalledWith(undefined)
    expect(stateShutdown).toHaveBeenCalledWith(undefined)
    expect(context.services.snapshotManager.shutdown).toHaveBeenCalled()
    expect(clearSyncMetadataStorage).not.toHaveBeenCalled()
    expect(context.services.indexStore.clear).not.toHaveBeenCalled()
  })

  it('marks local edits dirty and pending, and announces them to other tabs', () => {
    const markSpy = vi.spyOn(context.services.changeOutbox, 'mark')
    const { deps } = context.services.itemOperations as unknown as { deps: { markDocumentDirty: (id: ItemId) => void } }
    deps.markDocumentDirty('edited-item' as ItemId)

    expect(context.services.snapshotManager.schedule.markItemDirty).toHaveBeenCalledWith('edited-item')
    expect(markSpy).toHaveBeenCalledWith('edited-item')
    expect(realtimeBus.publishItemDirty).toHaveBeenCalledWith(['edited-item'])
  })

  it('marks items dirty when another tab announces local edits', () => {
    realtimeBus.receiveItemDirty(['tab-item-1', 'tab-item-2'] as ItemId[])

    expect(context.services.snapshotManager.schedule.markItemDirty).toHaveBeenCalledWith('tab-item-1')
    expect(context.services.snapshotManager.schedule.markItemDirty).toHaveBeenCalledWith('tab-item-2')
    expect(realtimeBus.publishItemDirty).not.toHaveBeenCalled()
    expect(context.services.orchestrator.flush).toHaveBeenCalled()
  })

  it('closes its realtime bus on shutdown', async () => {
    await context.shutdown()
    expect(realtimeBus.close).toHaveBeenCalledTimes(1)
  })

  it('marks the session shut down before stopping any component', async () => {
    let shutDownFirst: boolean | undefined
    vi.mocked(context.services.orchestrator.shutdown).mockImplementation(async () => {
      shutDownFirst = context.session.isShutdown
    })
    await context.shutdown()
    expect(shutDownFirst).toBe(true)
  })

  it('tells the snapshot manager about leaderChange', () => {
    depsOf<SyncOrchestratorDeps>(context.services.orchestrator).onLeaderChange!(true)
    expect(context.services.snapshotManager.onLeaderChange).toHaveBeenCalledTimes(1)
  })

  it('tells the other tabs when it starts or stops leading, while visible', () => {
    context.setVisibility(true)
    context.session.setLeader(true)
    depsOf<SyncOrchestratorDeps>(context.services.orchestrator).onLeaderChange!(true)
    expect(realtimeBus.publishTabVisibility).toHaveBeenLastCalledWith(expect.objectContaining({ visible: true, leader: true }))
  })

  describe('following the visible tab', () => {
    it('takes over when the user comes back while no visible tab leads', () => {
      context.setVisibility(false)
      context.setVisibility(true, true)
      expect(context.services.orchestrator.followVisibleTab).toHaveBeenCalledTimes(1)
    })

    it('leaves a visible leader alone', () => {
      context.setVisibility(false)
      realtimeBus.receiveTabVisibility({ tabId: 'leader-tab', visible: true, returned: false, leader: true })
      context.setVisibility(true, true)
      expect(context.services.orchestrator.followVisibleTab).not.toHaveBeenCalled()
    })

    it("takes over when the leader's report that it's hidden comes just after", () => {
      context.setVisibility(false)
      realtimeBus.receiveTabVisibility({ tabId: 'leader-tab', visible: true, returned: false, leader: true })
      context.setVisibility(true, true)
      realtimeBus.receiveTabVisibility({ tabId: 'leader-tab', visible: false, returned: false, leader: true })
      expect(context.services.orchestrator.followVisibleTab).toHaveBeenCalledTimes(1)
    })

    it('does not take over when it already leads', () => {
      context.session.setLeader(true)
      context.setVisibility(true, true)
      expect(context.services.orchestrator.followVisibleTab).not.toHaveBeenCalled()
    })
  })

  it('tells the orchestrator when the online state changes', () => {
    context.setOnlineState(true)
    expect(context.services.orchestrator.onOnlineStateChange).not.toHaveBeenCalled()

    context.setOnlineState(false)
    expect(context.session.isOnline).toBe(false)
    expect(context.services.orchestrator.onOnlineStateChange).toHaveBeenCalledTimes(1)
  })

  it('uploads snapshots as a phase of the poll, scheduled by the orchestrator', async () => {
    const managerDeps = depsOf<ConstructorParameters<typeof snapshotManagerModule.SnapshotManager>[0]>(
      context.services.snapshotManager,
    )
    const orchestratorDeps = depsOf<SyncOrchestratorDeps>(context.services.orchestrator)
    const pollerDeps = depsOf<SyncPollerDeps>(context.services.poller)

    expect(pollerDeps.getSnapshots()).toBe(context.services.snapshotManager)

    managerDeps.onDueChanged!()
    expect(context.services.orchestrator.onSnapshotDue).toHaveBeenCalledTimes(1)

    await managerDeps.runPollNow()
    expect(context.services.orchestrator.pollNow).toHaveBeenCalledTimes(1)

    Object.assign(context.services.snapshotManager.schedule, { nextDueAt: 1234 })
    expect(orchestratorDeps.getSnapshotDueAt!()).toBe(1234)
  })

  it('tells the other tabs its visibility, and polls when the user comes back', () => {
    context.setVisibility(false)
    expect(realtimeBus.publishTabVisibility).toHaveBeenLastCalledWith(expect.objectContaining({ visible: false }))
    expect(depsOf<SyncOrchestratorDeps>(context.services.orchestrator).getCadence!()).toBe('hidden')
    expect(context.services.orchestrator.onForeground).not.toHaveBeenCalled()

    context.setVisibility(true, true)
    expect(realtimeBus.publishTabVisibility).toHaveBeenLastCalledWith(expect.objectContaining({ visible: true, returned: true }))
    expect(depsOf<SyncOrchestratorDeps>(context.services.orchestrator).getCadence!()).toBe('idle')
    expect(context.services.orchestrator.onForeground).toHaveBeenCalledTimes(1)
  })

  it('polls when another tab of the account comes into view', () => {
    context.setVisibility(false)
    realtimeBus.receiveTabVisibility({ tabId: 'other-tab', visible: true, returned: true })
    expect(depsOf<SyncOrchestratorDeps>(context.services.orchestrator).getCadence!()).toBe('idle')
    expect(context.services.orchestrator.onForeground).toHaveBeenCalledTimes(1)
  })

  it('polls at the active rate after input here, tells the other tabs, and tells the orchestrator', () => {
    context.setVisibility(true)
    context.reportActivity()
    expect(realtimeBus.publishTabVisibility).toHaveBeenLastCalledWith(expect.objectContaining({ active: true }))
    expect(depsOf<SyncOrchestratorDeps>(context.services.orchestrator).getCadence!()).toBe('active')
    expect(context.services.orchestrator.onActivity).toHaveBeenCalledTimes(1)
  })

  it('polls at the active rate after input in another tab', () => {
    context.setVisibility(false)
    realtimeBus.receiveTabVisibility({ tabId: 'other-tab', visible: true, returned: false, active: true })
    expect(depsOf<SyncOrchestratorDeps>(context.services.orchestrator).getCadence!()).toBe('active')
    expect(context.services.orchestrator.onActivity).toHaveBeenCalledTimes(1)
  })

  describe('manual recovery event handling', () => {
    async function createContext() {
      const ctx = new SyncWorkerContext({
        accountId: 'test-account',
        keys: createMockKeyProvider(),
        clientEventHub: new ClientEventHub(),
        apiClient: new SyncApiClient(),
      })
      await ctx.initialize()
      return { ctx, pullDeps: depsOf<SyncLogPullerDeps>(ctx.services.puller) }
    }

    beforeEach(() => {
      mockRecoveryEntries.clear()
    })

    it('resolves pullDecryption quarantines once remote changes are applied', async () => {
      const { ctx, pullDeps } = await createContext()
      const resolveSpy = vi.spyOn(ctx.services.recoveryManager, 'resolveQuarantines').mockResolvedValue(undefined)

      pullDeps.onRemoteChangesApplied!('item-1' as ItemId)

      expect(resolveSpy).toHaveBeenCalledWith(['item-1'], INBOUND_MESSAGE_RESOLVABLE_KINDS)
    })
  })

  describe('retrySave', () => {
    it('returns failure if probe testStorageAvailable throws QuotaExceededError', async () => {
      const quotaErr = new DOMException('Quota exceeded', 'QuotaExceededError')
      vi.spyOn(context.services.indexStore, 'testStorageAvailable').mockRejectedValueOnce(quotaErr)

      const result = await context.retrySave()
      expect(result.success).toBe(false)
      expect(result.error).toContain('still exceeded')
    })

    it('saves dirty documents, marks them pending, saves their records, and emits quotaResolved on success', async () => {
      vi.spyOn(context.services.snapshotManager.schedule, 'getDirtyItemIds').mockReturnValue(['item-1' as ItemId, 'item-2' as ItemId])
      const saveDocSpy = vi.spyOn(context.services.docStore, 'saveDocToStorage').mockResolvedValue(true)
      const saveRecordsSpy = vi.spyOn(context.services.itemSyncState, 'save').mockResolvedValue(undefined)
      const emitSpy = vi.spyOn(context.clientEventHub, 'emit')
      const markSpy = vi.spyOn(context.services.changeOutbox, 'markAll')

      const result = await context.retrySave()

      expect(result.success).toBe(true)
      expect(saveDocSpy).toHaveBeenCalledWith('item-1' as ItemId)
      expect(saveDocSpy).toHaveBeenCalledWith('item-2' as ItemId)
      expect(markSpy).toHaveBeenCalledWith(['item-1', 'item-2'])
      expect(saveRecordsSpy).toHaveBeenCalled()
      expect(emitSpy).toHaveBeenCalledWith({ type: 'quotaResolved' })
    })
  })

  describe('getUnsyncedChanges', () => {
    function stubPending(options: {
      marked?: string[]
      dirty?: string[]
      quarantined?: string[]
      markedAt?: number
    }) {
      const marked = (options.marked ?? []) as ItemId[]
      vi.spyOn(context.services.changeOutbox, 'listPending').mockResolvedValue(marked)
      vi.spyOn(context.services.changeOutbox, 'listMarks').mockResolvedValue(
        marked.map(itemId => ({ itemId, tick: 1, createdAt: options.markedAt ?? Date.now() })),
      )
      vi.spyOn(context.services.snapshotManager.schedule, 'getDirtyItemIds').mockReturnValue((options.dirty ?? []) as ItemId[])
      vi.spyOn(context.services.recoveryManager, 'listRecoveryItems').mockResolvedValue(
        (options.quarantined ?? []).map(itemId => ({
          id: `entry-${itemId}`,
          itemId: itemId as ItemId,
          reason: 'failed',
          detail: { code: 'unspecified' } as const,
          kind: 'unknown' as const,
          createdAt: 0,
        })),
      )
    }

    it('pushes pending changes before counting them', async () => {
      stubPending({})

      expect(await context.getUnsyncedChanges()).toEqual({ pendingItems: 0, quarantinedItems: 0 })
      expect(context.services.orchestrator.flush).toHaveBeenCalled()
      expect(context.services.snapshotManager.flushPendingSnapshots).toHaveBeenCalled()
    })

    it('counts each item with a pending mark or a pending snapshot once, and quarantined items apart', async () => {
      stubPending({
        marked: ['item-1', 'item-2'],
        dirty: ['item-2', 'item-3', 'item-4'],
        quarantined: ['item-4', 'item-5', 'item-5'],
      })

      expect(await context.getUnsyncedChanges()).toEqual({ pendingItems: 3, quarantinedItems: 2 })
    })

    it('leaves pending snapshots out of the count of unpushed changes', async () => {
      stubPending({
        marked: ['item-1', 'item-2'],
        dirty: ['item-2', 'item-3'],
        quarantined: ['item-1'],
      })

      expect(await context.countUnpushedChanges()).toEqual({ pendingItems: 1, quarantinedItems: 1 })
    })

    it('counts the unpushed items that have waited too long, by what holds them up', async () => {
      stubPending({
        marked: ['item-1', 'item-2', 'item-3'],
        quarantined: ['item-3'],
        markedAt: Date.now() - SYNC_TIMEOUTS.stuckPendingAge,
      })

      expect(await context.countUnpushedChanges()).toEqual({
        pendingItems: 2,
        quarantinedItems: 1,
        stuckItems: { unknown: 2 },
      })
    })

    it('still counts when the snapshot push fails', async () => {
      stubPending({ dirty: ['item-1'] })
      vi.spyOn(context.services.snapshotManager, 'flushPendingSnapshots').mockRejectedValue(new Error('offline'))

      expect(await context.getUnsyncedChanges()).toEqual({ pendingItems: 1, quarantinedItems: 0 })
    })

    it('stops waiting for a snapshot push that does not finish', async () => {
      vi.useFakeTimers()
      try {
        stubPending({ dirty: ['item-1'] })
        vi.spyOn(context.services.snapshotManager, 'flushPendingSnapshots').mockReturnValue(new Promise(() => {}))

        const result = context.getUnsyncedChanges()
        await vi.advanceTimersByTimeAsync(SYNC_TIMEOUTS.unsyncedChangesFlush)

        expect(await result).toEqual({ pendingItems: 1, quarantinedItems: 0 })
      } finally {
        vi.useRealTimers()
      }
    })
  })

  it('saves the dirty flags and flushes the log push when the page is hidden, without forcing snapshots up', () => {
    const { orchestrator, snapshotManager, itemSyncState } = context.services
    const flushPendingSave = vi.spyOn(itemSyncState, 'flushPendingSave')

    context.onPageHidden()

    expect(flushPendingSave).toHaveBeenCalledTimes(1)
    expect(orchestrator.flush).toHaveBeenCalled()
    expect(snapshotManager.flushPendingSnapshots).not.toHaveBeenCalled()
  })

  it('wires manifestSyncManager into orchestrator on construction', () => {
    expect((context.services.orchestrator as any).deps.manifestSyncManager).toBe(context.services.manifestSyncManager)
  })

  describe('server I/O stays with the leader', () => {
    it('loads items at session start in the leader', async () => {
      context.session.setLeader(true)

      await context.bootstrapItems()

      expect(context.services.orchestrator.syncManifest).toHaveBeenCalledWith('due')
    })

    describe('when the manifest could not be fetched at session start', () => {
      beforeEach(() => {
        context.session.setLeader(true)
        vi.mocked(context.services.orchestrator.syncManifest)
          .mockResolvedValue({ added: [], success: false, fetchedManifest: false })
      })

      it('fails so that starting up is retried, on a device with no items', async () => {
        Object.assign(context.services.indexManager, { listItemIds: vi.fn().mockResolvedValue([]) })

        await expect(context.bootstrapItems()).rejects.toThrow(/Could not load/)
      })

      it('carries on with the items a device already has', async () => {
        Object.assign(context.services.indexManager, { listItemIds: vi.fn().mockResolvedValue(['item-1' as ItemId]) })

        await expect(context.bootstrapItems()).resolves.toBeUndefined()
      })

      it('leaves an expired session to the sign-in prompt', async () => {
        Object.assign(context.services.indexManager, { listItemIds: vi.fn().mockResolvedValue([]) })
        Object.assign(context.services.orchestrator, { isAuthPaused: true })

        await expect(context.bootstrapItems()).resolves.toBeUndefined()
      })
    })

    it('leaves loading items to the leader in another tab', async () => {
      await context.bootstrapItems()

      expect(context.services.orchestrator.settleLeadership).toHaveBeenCalledTimes(1)
      expect(context.services.orchestrator.syncManifest).not.toHaveBeenCalled()
    })

    it('takes over syncing before a full resync', async () => {
      expect(await context.fullResync()).toBe(true)

      expect(context.services.orchestrator.claimLeader).toHaveBeenCalledTimes(1)
      expect(context.session.isLeader).toBe(true)
      expect(context.services.orchestrator.syncManifest).toHaveBeenCalledWith('force')
      expect(context.services.orchestrator.flush).toHaveBeenCalled()
    })

    it('does not claim leadership it already has', async () => {
      context.session.setLeader(true)

      await context.becomeLeader()

      expect(context.services.orchestrator.claimLeader).not.toHaveBeenCalled()
    })

    it('fails when the claim does not make this tab the leader', async () => {
      vi.mocked(context.services.orchestrator.claimLeader).mockResolvedValue(false)

      await expect(context.fullResync()).rejects.toThrow(/could not take over/)
      expect(context.services.orchestrator.syncManifest).not.toHaveBeenCalled()
    })
  })

  it('delegates initialize and shutdown to lifecycle manager', async () => {
    const ctx = new SyncWorkerContext({
      accountId: 'test-account-lifecycle',
      keys: createMockKeyProvider(),
      clientEventHub,
      apiClient: new SyncApiClient(),
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
        apiClient: new SyncApiClient(),
        upgradeLocalEncryption: true,
      })
      vi.spyOn(ctx.lifecycle, 'start').mockResolvedValue(undefined)
      return { ctx, localKeys }
    }

    it('opens local storage under the local data lock, with the keys', async () => {
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
        }))
      } finally {
        vi.unstubAllGlobals()
      }
    })

    it('seals the index with the device key when storage is sealed', async () => {
      const cipher = { seal: vi.fn() }
      mockOpenLocalStorage.mockResolvedValueOnce({
        mode: 'sealed', retired: true, cipher, storage: { close: vi.fn() },
      })
      const { ctx } = createSealingContext()

      await ctx.initialize()

      expect((ctx.services.indexStore as any).options.cipher).toBe(cipher)
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
      mockPendingCount.mockResolvedValueOnce(3)
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
        apiClient: new SyncApiClient(),
        upgradeLocalEncryption: true,
        sealedDataVersion: 3,
      })
      vi.spyOn(ctx.lifecycle, 'start').mockResolvedValue(undefined)
      await ctx.initialize()
      return readMaxDeviceVersion(ctx)
    }

    it.each([
      ['plaintext storage', { mode: 'plaintext', retired: false }, 2],
      ['sealed storage with plaintext stores left', { mode: 'sealed', retired: false }, 2],
      ['sealed storage with the plaintext stores retired', { mode: 'sealed', retired: true }, Number.POSITIVE_INFINITY],
    ])('caps the device level on %s', async (_case, local, expected) => {
      const maxDeviceVersion = await createTrackedContext(local)

      await expect(maxDeviceVersion()).resolves.toBe(expected)
    })
  })

  describe('sync reset', () => {
    let resetSyncState: ReturnType<typeof vi.fn>
    let hasFinishedSyncReset: ReturnType<typeof vi.fn>

    beforeEach(() => {
      resetSyncState = vi.fn().mockResolvedValue(undefined)
      hasFinishedSyncReset = vi.fn().mockResolvedValue(false)
      spyOnExports(syncResetModule, { resetSyncState, hasFinishedSyncReset })
    })

    async function createContext(accountId: string, minDataVersion?: number) {
      mockOpenLocalStorage.mockResolvedValueOnce({ mode: 'sealed', retired: true, storage: { close: vi.fn() } })
      const ctx = new SyncWorkerContext({
        accountId,
        keys: createMockKeyProvider(),
        clientEventHub,
        apiClient: new SyncApiClient(),
        minDataVersion,
        sealedDataVersion: 3,
        syncResetDataVersion: 4,
      })
      vi.spyOn(ctx.lifecycle, 'start').mockResolvedValue(undefined)
      await ctx.initialize()
      return ctx
    }

    it('runs at start, and caps the device level below its level until it has finished', async () => {
      const ctx = await createContext('test-account-sync-reset')
      const maxDeviceVersion = readMaxDeviceVersion(ctx)

      expect(resetSyncState).toHaveBeenCalledTimes(1)
      expect(resetSyncState).toHaveBeenCalledWith('test-account-sync-reset', expect.any(Function))
      await expect(maxDeviceVersion()).resolves.toBe(3)

      hasFinishedSyncReset.mockResolvedValue(true)
      await expect(maxDeviceVersion()).resolves.toBe(Number.POSITIVE_INFINITY)
    })

    it('neither runs nor caps behind a device gate at its level', async () => {
      const ctx = await createContext('test-account-past-sync-reset', 4)

      expect(resetSyncState).not.toHaveBeenCalled()
      await expect(readMaxDeviceVersion(ctx)()).resolves.toBe(Number.POSITIVE_INFINITY)
      expect(hasFinishedSyncReset).not.toHaveBeenCalled()
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
        apiClient: new SyncApiClient(),
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
        apiClient: new SyncApiClient(),
        upgradeLocalEncryption: true,
      })
      vi.spyOn(ctx.lifecycle, 'start').mockResolvedValue(undefined)
      await ctx.initialize()
      const { onOpenFailure } = mockOpenLocalStorage.mock.lastCall![0] as {
        onOpenFailure: (key: string[], error: unknown) => void
      }
      return { ctx, onOpenFailure }
    }

    /** Asks the predicate the context gave its (mocked) doc store */
    function isLocallyUnreadable(ctx: SyncWorkerContext, documentId: DocumentId): boolean {
      return depsOf<{ isLocallyUnreadable: (documentId: DocumentId) => boolean }>(ctx.services.docStore).isLocallyUnreadable(documentId)
    }

    it('quarantines a document once, however many of its chunks fail', async () => {
      const { ctx, onOpenFailure } = await createContextWithOpenFailures()
      const reportSpy = vi.spyOn(ctx.services.recoveryManager, 'reportDecryptionFailure').mockResolvedValue(undefined)
      const error = new Error('bad tag')

      onOpenFailure(['doc-1', 'snapshot', 'heads-1'], error)
      onOpenFailure(['doc-1', 'incremental', 'change-1'], error)

      expect(reportSpy).toHaveBeenCalledTimes(1)
      expect(reportSpy).toHaveBeenCalledWith('doc-1', 'localDecryption', error)
      expect(isLocallyUnreadable(ctx, 'doc-1' as DocumentId)).toBe(true)
      expect(isLocallyUnreadable(ctx, 'doc-2' as DocumentId)).toBe(false)
    })

    it('ignores the storage ID record, which is not a document', async () => {
      const { ctx, onOpenFailure } = await createContextWithOpenFailures()
      const reportSpy = vi.spyOn(ctx.services.recoveryManager, 'reportDecryptionFailure').mockResolvedValue(undefined)

      onOpenFailure(['storage-adapter-id'], new Error('bad tag'))

      expect(reportSpy).not.toHaveBeenCalled()
    })

    it('stops reporting a document unreadable once its local copy is discarded', async () => {
      const { ctx, onOpenFailure } = await createContextWithOpenFailures()
      vi.spyOn(ctx.services.recoveryManager, 'reportDecryptionFailure').mockResolvedValue(undefined)
      const documentId = toDocumentIdFromItemId('item-unreadable' as ItemId)
      onOpenFailure([documentId, 'snapshot', 'heads-1'], new Error('bad tag'))

      depsOf<ItemRecoveryServiceDeps>(ctx.services.itemRecoveryService).onLocalCopyDiscarded(documentId)

      expect(isLocallyUnreadable(ctx, documentId)).toBe(false)
    })
  })

  describe('migrateLocalData', () => {
    function createMigratingContext(migrateLocalData: (accountId: string) => Promise<void>) {
      return new SyncWorkerContext({
        accountId: 'test-account-migrate',
        keys: createMockKeyProvider(),
        clientEventHub,
        apiClient: new SyncApiClient(),
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
        apiClient: new SyncApiClient(),
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
        apiClient: new SyncApiClient(),
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
        apiClient: new SyncApiClient(),
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
        apiClient: new SyncApiClient(),
        upgradeSnapshotFormat: true,
      })
      await ctx.initialize()
      expect(ctx.services.snapshotFormatUpgrade).toBeInstanceOf(SnapshotFormatUpgrade)
    })
  })

  it('registers expected services in lifecycle manager in correct order', async () => {
    const ctx = new SyncWorkerContext({
      accountId: 'test-account-lifecycle',
      keys: createMockKeyProvider(),
      clientEventHub,
      apiClient: new SyncApiClient(),
    })
    const registerSpy = vi.spyOn(ctx.lifecycle, 'register')
    await ctx.initialize()

    const serviceNames = registerSpy.mock.calls.map(([registration]) => registration.name)
    expect(serviceNames).toEqual([
      'RealtimeBus',
      'ForegroundTracker',
      'SyncLogDatabase',
      'RepoManager',
      'ItemSyncState',
      'StorageRecoveryService',
      'IndexManager',
      'IndexDocument',
      'RecoveryManager',
      'DocStore',
      'SnapshotManager',
      'ChangeOutbox',
      'SyncLogPuller',
      'ManifestSyncManager',
      'SyncOrchestrator',
      'ItemReencryptor',
      'SyncProgressTracker',
    ])
  })

  it('passes poll results to the status manager and the sync progress tracker', () => {
    const onPollResult = vi.spyOn(context.services.syncProgress, 'onPollResult')
    const handlePollResult = vi.spyOn(context.statusManager, 'handlePollResult')

    ;(context.services.orchestrator as any).deps.onPollResult('success')

    expect(handlePollResult).toHaveBeenCalledWith('success')
    expect(onPollResult).toHaveBeenCalledWith('success')
  })

  it('uses the given apiClient', async () => {
    const apiClient = new SyncApiClient()
    const ctx = new SyncWorkerContext({
      accountId: 'test-account-api-client',
      keys: createMockKeyProvider(),
      clientEventHub,
      apiClient,
    })

    expect(ctx.apiClient).toBe(apiClient)
  })
})


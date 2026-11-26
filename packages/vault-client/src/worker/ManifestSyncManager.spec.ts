import { MAX_FETCH_RESPONSE_CHARS } from '@vault/shared'
import { ManifestDemands, type ManifestDemand } from './ManifestDemands'
import { ManifestHydrator } from './ManifestHydrator'
import { ManifestSyncManager, type ManifestMode } from './ManifestSyncManager'
import { SyncSessionState } from './SyncSessionState'
import { SnapshotSchedule } from './SnapshotSchedule'
import { RecoveryManager } from './RecoveryManager'
import { ClientEventHub } from './SyncEventHub'
import { SyncApiClient } from './SyncApiClient'
import type { ItemId } from '@vault/shared'
import * as Automerge from '@automerge/automerge/slim'
import { SYNC_TIMEOUTS } from '../shared/syncConfig'

// Mock dependencies
const mockListItemIds = vi.fn()
const mockListTombstoneIds = vi.fn()
const mockRemoveItemIds = vi.fn()
const mockHydrateAutomergeDocumentBinary = vi.fn()
const mockGetMetadata = vi.fn()
const mockAddItemIds = vi.fn()
const mockGetLastManifestSyncTime = vi.fn()
const mockUpdateLastManifestSyncTime = vi.fn()

const mockFetchManifest = vi.fn()
const mockFetchSnapshotsByIds = vi.fn()
import { createMockKeyProvider, createMockVault, spyOnVaultTrpc } from './__test__/testUtils'
import { spyOnExports } from '../../test/moduleMocks'
import * as docStoreModule from './docStore'
import * as manualRecoveryStoreModule from '../shared/manualRecoveryStore'
import * as runtimeModule from '../keys/runtime'

const mockVault = createMockVault()
const keys = createMockKeyProvider(mockVault)
const {
  decryptBytes: mockDecryptBytes,
  hasVaultKey: mockHasVaultKey,
  waitForKeyVersion: mockWaitForKeyVersion,
} = mockVault
const mockReadManualRecoveryEntries = vi.fn().mockResolvedValue([])
const mockHasApiAuthToken = vi.fn()
beforeEach(() => {
  spyOnExports(docStoreModule, {
    AutomergeDocStore: vi.fn().mockImplementation(() => ({
      hydrateAutomergeDocumentBinary: mockHydrateAutomergeDocumentBinary,
    })),
    AutomergeIndexManager: vi.fn().mockImplementation(() => ({
      listItemIds: mockListItemIds,
      listTombstoneIds: mockListTombstoneIds,
      removeItemIds: mockRemoveItemIds,
      getMetadata: mockGetMetadata,
      addItemIds: mockAddItemIds,
      getLastManifestSyncTime: mockGetLastManifestSyncTime,
      updateLastManifestSyncTime: mockUpdateLastManifestSyncTime,
    })),
  })
  // The mocks return the procedures' data without the `success` flag the server adds
  spyOnVaultTrpc({
    fetchManifest: async (...args: any[]) => ({ success: true, ...await mockFetchManifest(...args) }),
    fetchSnapshotsByIds: async (...args: any[]) => ({ success: true, ...await mockFetchSnapshotsByIds(...args) }),
  })
  spyOnExports(manualRecoveryStoreModule, {
    readManualRecoveryEntries: (...args: any[]) => mockReadManualRecoveryEntries(...args),
  })
  spyOnExports(runtimeModule, {
    setApiAuthToken: vi.fn(),
    hasApiAuthToken: () => mockHasApiAuthToken(),
    getApiAuthToken: () => (mockHasApiAuthToken() ? 'session-token' : ''),
  })
})

/** A manager with its own hydrator, which takes the hydrator's deps from the same object */
function createManager(deps: any): ManifestSyncManager {
  return new ManifestSyncManager({ ...deps, hydrator: new ManifestHydrator(deps) })
}

/** A sync at `mode`, as the poll's manifest phase runs one when asked for it */
function sync(manager: ManifestSyncManager, mode: ManifestMode = 'due', signal = new AbortController().signal) {
  manager.request(mode)
  return manager.runPhase('afterRead', signal)
}

/** A session that has shut down, in which nothing may reach the server */
function shutDownSession(): SyncSessionState {
  const session = new SyncSessionState()
  session.markShutdown()
  return session
}

describe('ManifestSyncManager', () => {
  let manifestSyncManager: ManifestSyncManager
  let storeItemsSpy: any
  let migrateLegacySettingsSpy: any
  let depsObj: {
    accountId: string
    session: SyncSessionState
    demands: ManifestDemands
    docStore: any
    indexManager: any
    snapshotSchedule: any
    snapshotPusher: any
    itemSyncState: any
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockVault.reset()

    const mockDocStore = {
      hydrateAutomergeDocumentBinary: mockHydrateAutomergeDocumentBinary,
      flushToStorage: vi.fn().mockResolvedValue(undefined),
    } as any

    const mockIndexManager = {
      listItemIds: mockListItemIds,
      listTombstoneIds: mockListTombstoneIds,
      removeItemIds: mockRemoveItemIds,
      getMetadata: mockGetMetadata,
      addItemIds: mockAddItemIds,
      getLastManifestSyncTime: mockGetLastManifestSyncTime,
      updateLastManifestSyncTime: mockUpdateLastManifestSyncTime,
    } as any

    const trackedItems = vi.fn().mockReturnValue([])
    const mockSnapshotSchedule = {
      deleteDirtyItem: vi.fn().mockReturnValue(true),
      markItemDirty: vi.fn(),
      requestNow: vi.fn(),
    } as any
    const mockSnapshotPusher = {
      pushDue: vi.fn().mockResolvedValue({ persisted: 0, total: 0, success: true }),
    } as any

    storeItemsSpy = vi.fn().mockResolvedValue(undefined)
    migrateLegacySettingsSpy = vi.fn().mockResolvedValue(undefined)

    depsObj = {
      accountId: 'acc-123',
      session: new SyncSessionState(),
      demands: new ManifestDemands(),
      docStore: mockDocStore,
      indexManager: mockIndexManager,
      snapshotSchedule: mockSnapshotSchedule,
      snapshotPusher: mockSnapshotPusher,
      keys,
      storeItems: storeItemsSpy,
      migrateLegacySettings: migrateLegacySettingsSpy,
      recoveryManager: new RecoveryManager({ accountId: 'acc-123', eventHub: new ClientEventHub() }),
      apiClient: new SyncApiClient(),
      itemSyncState: {
        // Not the state's own: the items it has base versions for, as tests set them
        trackedItems,
        listBaseVersions: vi.fn().mockImplementation(() => new Map(
          ((trackedItems() ?? []) as Array<[ItemId, number]>).map(([id]) => [id, 1]),
        )),
        importBaseVersions: vi.fn().mockResolvedValue(undefined),
        listUnconfirmedPulls: vi.fn().mockReturnValue(new Map()),
        confirmPulledChanges: vi.fn().mockResolvedValue(undefined),
        isDirty: vi.fn().mockReturnValue(false),
        listDirty: vi.fn().mockReturnValue([]),
        dirtyCount: 0,
      },
    } as any

    manifestSyncManager = createManager(depsObj as any)

    // Default mock behaviors
    mockListItemIds.mockResolvedValue([])
    mockListTombstoneIds.mockResolvedValue([])
    mockRemoveItemIds.mockResolvedValue(undefined)
    mockHasApiAuthToken.mockReturnValue(true)
    mockGetMetadata.mockResolvedValue({})
    mockGetLastManifestSyncTime.mockResolvedValue(0)
    mockUpdateLastManifestSyncTime.mockResolvedValue(undefined)
    mockHydrateAutomergeDocumentBinary.mockResolvedValue(undefined)
    mockHasVaultKey.mockReturnValue(true)
    mockWaitForKeyVersion.mockResolvedValue(true)
    mockReadManualRecoveryEntries.mockResolvedValue([])
  })

  describe('once the session has shut down', () => {
    it('never talks to the server', async () => {
      const manager = createManager({ ...depsObj, session: shutDownSession() })
      manager.request('force')

      expect(await sync(manager, 'force')).toBeNull()
      expect(manager.getDueAt()).toBeUndefined()

      expect(mockFetchManifest).not.toHaveBeenCalled()
      expect(mockFetchSnapshotsByIds).not.toHaveBeenCalled()
    })
  })

  describe('the poll phase', () => {
    const MINUTE = 60 * 1000
    const signal = () => new AbortController().signal

    afterEach(() => {
      vi.useRealTimers()
    })

    it('runs nothing while nothing is asked for and the periodic sync is not due', async () => {
      mockListItemIds.mockResolvedValue(['item-1'])
      mockGetLastManifestSyncTime.mockResolvedValue(Date.now() - 49 * MINUTE)

      expect(await manifestSyncManager.runPhase('afterRead', signal())).toBeNull()

      expect(mockFetchManifest).not.toHaveBeenCalled()
    })

    it('runs the periodic sync once the minimum gap since the last clean one has passed', async () => {
      mockListItemIds.mockResolvedValue(['item-1'])
      mockGetLastManifestSyncTime.mockResolvedValue(Date.now() - 51 * MINUTE)
      mockFetchManifest.mockResolvedValue({ manifest: [] })

      expect(await manifestSyncManager.runPhase('afterRead', signal())).toMatchObject({ success: true, fetchedManifest: true })

      expect(mockFetchManifest).toHaveBeenCalledTimes(1)
    })

    it('waits the interval, not the minimum gap, after a sync in which items failed', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      mockListItemIds.mockResolvedValue(['item-1'])
      mockGetLastManifestSyncTime.mockResolvedValue(0)
      mockFetchManifest.mockResolvedValue({
        manifest: [{ itemId: 'item-2', version: 1, modifiedAt: 1 }],
      })
      mockFetchSnapshotsByIds.mockResolvedValue({ items: [], deferred: ['item-2'] })

      expect(await manifestSyncManager.runPhase('afterRead', signal())).toMatchObject({ success: false, fetchedManifest: true })
      expect(mockUpdateLastManifestSyncTime).not.toHaveBeenCalled()
      expect(manifestSyncManager.getDueAt()).toBe(Date.now() + SYNC_TIMEOUTS.manifestSyncInterval)
      expect(await manifestSyncManager.runPhase('afterRead', signal())).toBeNull()

      vi.setSystemTime(Date.now() + SYNC_TIMEOUTS.manifestSyncInterval)
      await manifestSyncManager.runPhase('afterRead', signal())

      expect(mockFetchManifest).toHaveBeenCalledTimes(2)
    })

    it('is due an interval after a clean sync, since it fetched the manifest then too', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      mockListItemIds.mockResolvedValue(['item-1'])
      mockFetchManifest.mockResolvedValue({ manifest: [] })

      await sync(manifestSyncManager, 'now')

      expect(manifestSyncManager.getDueAt()).toBe(Date.now() + SYNC_TIMEOUTS.manifestSyncInterval)
    })

    it('is due now while a sync is asked for', async () => {
      manifestSyncManager.request('due')

      expect(manifestSyncManager.getDueAt(1234)).toBe(1234)
    })

    it('runs inside the minimum gap when asked for one now, and says it fetched the manifest', async () => {
      mockListItemIds.mockResolvedValue(['item-1'])
      mockGetLastManifestSyncTime.mockResolvedValue(Date.now())
      mockFetchManifest.mockResolvedValue({ manifest: [] })
      const onManifestProcessed = vi.fn().mockResolvedValue(undefined)
      const manager = createManager({ ...depsObj, onManifestProcessed } as any)

      expect(await sync(manager, 'now')).toMatchObject({ fetchedManifest: true })

      expect(mockFetchManifest).toHaveBeenCalledTimes(1)
      expect(onManifestProcessed).toHaveBeenCalledWith([])
    })

    it('runs a sync asked for by an event once, at the strongest mode asked for', async () => {
      mockListItemIds.mockResolvedValue(['item-1'])
      mockGetLastManifestSyncTime.mockResolvedValue(Date.now())
      mockFetchManifest.mockResolvedValue({ manifest: [] })
      manifestSyncManager.request('now')
      manifestSyncManager.request('due')

      expect(await manifestSyncManager.runPhase('afterRead', signal())).toMatchObject({ fetchedManifest: true })
      expect(await manifestSyncManager.runPhase('afterRead', signal())).toBeNull()

      expect(mockFetchManifest).toHaveBeenCalledTimes(1)
    })

    // Rule 4: the poll fails and backs off, and tries again next time
    it('throws when the manifest cannot be fetched, keeping what was asked for', async () => {
      mockListItemIds.mockResolvedValue(['item-1'])
      mockFetchManifest.mockRejectedValueOnce(new TypeError('Failed to fetch'))
      manifestSyncManager.request('now')

      await expect(manifestSyncManager.runPhase('afterRead', signal())).rejects.toThrow('Failed to fetch')

      mockGetLastManifestSyncTime.mockResolvedValue(Date.now())
      mockFetchManifest.mockResolvedValue({ manifest: [] })
      expect(await manifestSyncManager.runPhase('afterRead', signal())).toMatchObject({ fetchedManifest: true })
    })

    it('throws when the manifest cannot be fetched on a device with no items', async () => {
      mockListItemIds.mockResolvedValue([])
      mockFetchManifest.mockRejectedValue(new Error('Network offline'))

      await expect(sync(manifestSyncManager)).rejects.toThrow('Network offline')
    })

    it('counts a sync that merged only some items as having fetched the manifest', async () => {
      mockFetchManifest.mockResolvedValue({
        manifest: [{ itemId: 'item-1', version: 1, modifiedAt: 1 }],
      })
      mockFetchSnapshotsByIds.mockResolvedValue({ items: [], deferred: ['item-1'] })

      expect(await sync(manifestSyncManager, 'now')).toMatchObject({ success: false, fetchedManifest: true })
    })

    it('fails when a snapshot request fails as a whole, so the poll backs off (rule 4)', async () => {
      mockFetchManifest.mockResolvedValue({
        manifest: [{ itemId: 'item-1', version: 1, modifiedAt: 1 }],
      })
      mockFetchSnapshotsByIds.mockRejectedValue({ message: 'boom', data: { httpStatus: 500 } })

      await expect(sync(manifestSyncManager, 'now')).rejects.toMatchObject({ message: 'boom' })
      expect(mockUpdateLastManifestSyncTime).not.toHaveBeenCalled()
    })

    it('still counts as run when processing the manifest fails, which the next sync retries', async () => {
      mockFetchManifest.mockResolvedValue({ manifest: [] })
      const onManifestProcessed = vi.fn().mockRejectedValue(new Error('failed'))
      const manager = createManager({ ...depsObj, onManifestProcessed } as any)

      expect(await sync(manager, 'now')).toMatchObject({ fetchedManifest: true })
    })

    describe('demands', () => {
      const beforeRead = (onFetched = vi.fn()): ManifestDemand => ({ purpose: 'Catching up', beforeRead: true, onFetched })
      const afterRead = (onFetched = vi.fn()): ManifestDemand => ({ purpose: 'Recovering lost log rows', beforeRead: false, onFetched })

      beforeEach(() => {
        mockListItemIds.mockResolvedValue(['item-1'])
        mockGetLastManifestSyncTime.mockResolvedValue(Date.now())
        mockFetchManifest.mockResolvedValue({ manifest: [] })
      })

      it('runs a demand before the read only if it must run then', async () => {
        const recovery = afterRead()
        depsObj.demands.demand(recovery)
        manifestSyncManager.request('now')

        expect(await manifestSyncManager.runPhase('beforeRead', signal())).toBeNull()
        expect(mockFetchManifest).not.toHaveBeenCalled()

        expect(await manifestSyncManager.runPhase('afterRead', signal())).toMatchObject({ fetchedManifest: true })
        expect(recovery.onFetched).toHaveBeenCalledTimes(1)
        expect(depsObj.demands.isDemanded(recovery)).toBe(false)
      })

      it('runs inside the minimum gap, and is due now until met', async () => {
        const catchUp = beforeRead()
        depsObj.demands.demand(catchUp)
        expect(manifestSyncManager.getDueAt(1234)).toBe(1234)

        expect(await manifestSyncManager.runPhase('beforeRead', signal())).toMatchObject({ fetchedManifest: true })

        expect(catchUp.onFetched).toHaveBeenCalledTimes(1)
        expect(depsObj.demands.isDemanded(catchUp)).toBe(false)
      })

      it('meets every demand and request with one sync, so nothing runs after the read', async () => {
        const catchUp = beforeRead()
        const recovery = afterRead()
        depsObj.demands.demand(recovery)
        depsObj.demands.demand(catchUp)
        depsObj.demands.demand(catchUp)
        manifestSyncManager.request('now')

        await manifestSyncManager.runPhase('beforeRead', signal())

        expect(await manifestSyncManager.runPhase('afterRead', signal())).toBeNull()
        expect(mockFetchManifest).toHaveBeenCalledTimes(1)
        expect(catchUp.onFetched).toHaveBeenCalledTimes(1)
        expect(recovery.onFetched).toHaveBeenCalledTimes(1)
      })

      // Rule 4: a recovery request stays until a sync fetches the manifest
      it('stays when the manifest cannot be fetched', async () => {
        const recovery = afterRead()
        depsObj.demands.demand(recovery)
        mockFetchManifest.mockRejectedValueOnce(new TypeError('Failed to fetch'))

        await expect(manifestSyncManager.runPhase('afterRead', signal())).rejects.toThrow('Failed to fetch')

        expect(recovery.onFetched).not.toHaveBeenCalled()
        expect(depsObj.demands.isDemanded(recovery)).toBe(true)
        await manifestSyncManager.runPhase('afterRead', signal())
        expect(recovery.onFetched).toHaveBeenCalledTimes(1)
      })

      it('is not met by a demand placed while a sync runs', async () => {
        const recovery = afterRead()
        mockFetchManifest.mockImplementationOnce(async () => {
          depsObj.demands.demand(recovery)
          return { manifest: [] }
        })
        manifestSyncManager.request('now')

        await manifestSyncManager.runPhase('afterRead', signal())

        expect(depsObj.demands.isDemanded(recovery)).toBe(true)
      })

      it('fails the phase once the session has shut down, so the poll cannot report success without it', async () => {
        const manager = createManager({ ...depsObj, session: shutDownSession() })
        depsObj.demands.demand(beforeRead())

        await expect(manager.runPhase('beforeRead', signal())).rejects.toThrow('Catching up')
        expect(mockFetchManifest).not.toHaveBeenCalled()
      })
    })

    describe('tickets', () => {
      it('runs at the mode a ticket asks for and gives it the result', async () => {
        mockListItemIds.mockResolvedValue(['item-1'])
        mockGetLastManifestSyncTime.mockResolvedValue(Date.now())
        mockFetchManifest.mockResolvedValue({ manifest: [] })
        const ticket = manifestSyncManager.openTicket('force')

        const result = await manifestSyncManager.runPhase('afterRead', signal())

        expect(mockFetchManifest).toHaveBeenCalledTimes(1)
        expect(manifestSyncManager.closeTicket(ticket)).toBe(result)
      })

      it('serves a weaker ticket with a stronger sync', async () => {
        mockListItemIds.mockResolvedValue(['item-1'])
        mockGetLastManifestSyncTime.mockResolvedValue(Date.now())
        mockFetchManifest.mockResolvedValue({ manifest: [] })
        const ticket = manifestSyncManager.openTicket('due')

        await sync(manifestSyncManager, 'now')

        expect(manifestSyncManager.closeTicket(ticket)).toMatchObject({ fetchedManifest: true })
      })

      it('serves a due ticket with a sync that skipped itself', async () => {
        mockListItemIds.mockResolvedValue(['item-1'])
        mockGetLastManifestSyncTime.mockResolvedValue(Date.now())
        const ticket = manifestSyncManager.openTicket('due')

        await manifestSyncManager.runPhase('afterRead', signal())

        expect(mockFetchManifest).not.toHaveBeenCalled()
        expect(manifestSyncManager.closeTicket(ticket)).toEqual({ added: [], success: true, fetchedManifest: false })
      })

      it('returns a failure for a ticket no sync served, and leaves nothing asked for', async () => {
        mockListItemIds.mockResolvedValue(['item-1'])
        mockGetLastManifestSyncTime.mockResolvedValue(Date.now())
        const ticket = manifestSyncManager.openTicket('force')

        expect(manifestSyncManager.closeTicket(ticket)).toEqual({ added: [], success: false, fetchedManifest: false })
        expect(await manifestSyncManager.runPhase('afterRead', signal())).toBeNull()
      })
    })
  })

  describe('fetchSnapshots', () => {
    it('hydrates the given items without the manifest', async () => {
      mockListItemIds.mockResolvedValue(['item-1'])
      mockFetchSnapshotsByIds.mockResolvedValue({
        items: [{ item: 'item-1', version: 3, snapshot: { iv: 'iv-1', cipher: 'cipher-1', kver: '1' } }],
      })
      mockDecryptBytes.mockResolvedValue(new Uint8Array([1, 2, 3]))
      mockHydrateAutomergeDocumentBinary.mockResolvedValue({ hasLocalChanges: false, incomingHeads: ['head'] })

      await new ManifestHydrator(depsObj as any).fetchSnapshots(['item-1' as ItemId])

      expect(mockHydrateAutomergeDocumentBinary).toHaveBeenCalledWith('item-1', new Uint8Array([1, 2, 3]), { knownToExist: true })
      expect(depsObj.itemSyncState.importBaseVersions).toHaveBeenCalledWith([['item-1', 3]])
    })
  })

  describe('gating & lifecycle', () => {

    it('skips sync if known items exist and the last sync was within the minimum gap', async () => {
      mockListItemIds.mockResolvedValue(['item-1'])
      mockGetLastManifestSyncTime.mockResolvedValue(Date.now() - 49 * 60 * 1000)

      const result = await sync(manifestSyncManager)

      expect(result).toEqual({ added: [], success: true, fetchedManifest: false })
      expect(mockFetchManifest).not.toHaveBeenCalled()
    })

    it('forces sync when force=true even within the minimum gap', async () => {
      mockListItemIds.mockResolvedValue(['item-1'])
      mockGetLastManifestSyncTime.mockResolvedValue(Date.now() - 3600 * 1000)
      mockFetchManifest.mockResolvedValue({ manifest: [{ itemId: 'item-1', modifiedAt: 100 }] })

      await sync(manifestSyncManager, 'force')

      expect(mockFetchManifest).toHaveBeenCalledWith({ account: 'acc-123' }, { signal: expect.any(AbortSignal) })
    })

    it('syncs once the minimum gap has passed', async () => {
      mockListItemIds.mockResolvedValue(['item-1'])
      mockGetLastManifestSyncTime.mockResolvedValue(Date.now() - 51 * 60 * 1000)
      mockFetchManifest.mockResolvedValue({ manifest: [{ itemId: 'item-1', modifiedAt: 100 }] })

      await sync(manifestSyncManager)

      expect(mockFetchManifest).toHaveBeenCalledWith({ account: 'acc-123' }, { signal: expect.any(AbortSignal) })
    })

    // The poll classifies it, and pauses for sign-in
    it('throws when there is no session to fetch the manifest with', async () => {
      mockListItemIds.mockResolvedValue(['item-1'])
      mockGetLastManifestSyncTime.mockResolvedValue(0)
      mockHasApiAuthToken.mockReturnValue(false)

      await expect(sync(manifestSyncManager)).rejects.toThrow()
      expect(mockFetchManifest).not.toHaveBeenCalled()
    })
  })

  describe('cold start & discovery', () => {
    it('performs cold start: fetches manifest, finds all missing items, fetches snapshots, and hydrates them', async () => {
      mockListItemIds.mockResolvedValue([])
      mockFetchManifest.mockResolvedValue({
        manifest: [
          { itemId: 'item-snap', modifiedAt: 100 },
          { itemId: 'item-legacy', modifiedAt: 200 },
          { itemId: 'item-deleted', modifiedAt: 300 },
        ],
      })

      mockFetchSnapshotsByIds.mockResolvedValue({
        items: [
          {
            item: 'item-deleted',
            metadata: { deleted: true },
          },
          {
            item: 'item-snap',
            snapshot: { iv: 'iv-1', cipher: 'cipher-1', kver: '1' },
          },
          {
            item: 'item-legacy',
            cipher: 'legacy-cipher',
            metadata: { iv: 'legacy-iv' },
          },
        ],
      })

      mockDecryptBytes.mockResolvedValue(new Uint8Array([1, 2, 3]))
      const decodeLegacyItem = vi.fn().mockResolvedValue({ type: 'person', name: 'Alice' })
      const manager = createManager({ ...depsObj, decodeLegacyItem } as any)

      const result = await sync(manager)

      expect(mockFetchManifest).toHaveBeenCalledWith({ account: 'acc-123' }, { signal: expect.any(AbortSignal) })
      expect(mockFetchSnapshotsByIds).toHaveBeenCalledWith({
        account: 'acc-123',
        itemIds: ['item-snap', 'item-legacy', 'item-deleted'],
        maxResponseChars: MAX_FETCH_RESPONSE_CHARS,
      }, { signal: expect.any(AbortSignal) })

      expect(mockDecryptBytes).toHaveBeenCalledWith({ iv: 'iv-1', cipher: 'cipher-1', kver: '1' }, 'item-snap')
      expect(mockHydrateAutomergeDocumentBinary).toHaveBeenCalledWith('item-snap', new Uint8Array([1, 2, 3]), { knownToExist: false })
      expect(mockAddItemIds).toHaveBeenCalledWith(['item-snap'])

      expect(decodeLegacyItem).toHaveBeenCalledWith(
        expect.objectContaining({ item: 'item-legacy', cipher: 'legacy-cipher' }),
        expect.objectContaining({ ensureKey: expect.any(Function) }),
      )
      expect(storeItemsSpy).toHaveBeenCalledWith([{ id: 'item-deleted', deleted: true }], { markDirty: false })
      // Decoded legacy items upload a snapshot straight away
      expect(storeItemsSpy).toHaveBeenCalledWith(
        [{ id: 'item-legacy', type: 'person', name: 'Alice' }],
        { markDirty: true },
      )

      expect(mockUpdateLastManifestSyncTime).toHaveBeenCalled()
      expect(result).toMatchObject({ added: ['item-snap'], success: true })
    })

    it('reports legacy rows without a hook as needing migration, and does not count the sync as complete', async () => {
      mockListItemIds.mockResolvedValue([])
      mockFetchManifest.mockResolvedValue({
        manifest: [{ itemId: 'item-legacy', modifiedAt: 200 }],
      })
      mockFetchSnapshotsByIds.mockResolvedValue({
        items: [{ item: 'item-legacy', cipher: 'legacy-cipher', metadata: { iv: 'legacy-iv' } }],
      })
      const onMigrationRequired = vi.fn()
      const onSyncedWithoutFailures = vi.fn()
      const manager = createManager({ ...depsObj, onMigrationRequired, onSyncedWithoutFailures } as any)

      const result = await sync(manager)

      expect(result).toMatchObject({ added: [], success: false })
      expect(onMigrationRequired).toHaveBeenCalledTimes(1)
      expect(onSyncedWithoutFailures).not.toHaveBeenCalled()
      expect(storeItemsSpy).not.toHaveBeenCalled()
    })

    it('performs warm path: fetches missing items and outdated known items', async () => {
      mockListItemIds.mockResolvedValue(['item-1' as ItemId, 'item-2' as ItemId])
      mockGetLastManifestSyncTime.mockResolvedValue(0)
      depsObj.itemSyncState.trackedItems.mockReturnValue([['item-1', 100], ['item-2', 100]])
      mockFetchManifest.mockResolvedValue({
        manifest: [
          { itemId: 'item-1', modifiedAt: 100 },
          { itemId: 'item-2', modifiedAt: 100 },
          { itemId: 'item-3', modifiedAt: 150 },
        ],
      })

      mockFetchSnapshotsByIds.mockResolvedValue({
        items: [
          {
            item: 'item-3',
            snapshot: { iv: 'iv-3', cipher: 'cipher-3' },
          },
        ],
      })

      mockDecryptBytes.mockResolvedValue(new Uint8Array([9, 9]))

      const result = await sync(manifestSyncManager)

      expect(mockFetchSnapshotsByIds).toHaveBeenCalledWith({
        account: 'acc-123',
        itemIds: ['item-3'],
        maxResponseChars: MAX_FETCH_RESPONSE_CHARS,
      }, { signal: expect.any(AbortSignal) })
      expect(mockHydrateAutomergeDocumentBinary).toHaveBeenCalledWith('item-3', new Uint8Array([9, 9]), { knownToExist: false })
      expect(mockAddItemIds).toHaveBeenCalledWith(['item-3'])
      expect(result).toMatchObject({ added: ['item-3'], success: true })
    })

    it('is a no-op when all manifest items are already known and up to date', async () => {
      mockListItemIds.mockResolvedValue(['item-1' as ItemId, 'item-2' as ItemId])
      mockGetLastManifestSyncTime.mockResolvedValue(0)
      depsObj.itemSyncState.trackedItems.mockReturnValue([['item-1', 100], ['item-2', 100]])
      mockFetchManifest.mockResolvedValue({
        manifest: [
          { itemId: 'item-1', modifiedAt: 100 },
          { itemId: 'item-2', modifiedAt: 100 },
        ],
      })

      const result = await sync(manifestSyncManager)

      expect(mockFetchSnapshotsByIds).not.toHaveBeenCalled()
      expect(mockUpdateLastManifestSyncTime).toHaveBeenCalled()
      expect(result).toMatchObject({ added: [], success: true })
    })

    it('is a no-op when manifest contains an already-synced deleted item not in knownSet', async () => {
      // Deleted items are excluded from active index doc (listItemIds), and kept in its tombstones
      mockListItemIds.mockResolvedValue(['item-active' as ItemId])
      mockListTombstoneIds.mockResolvedValue(['item-deleted' as ItemId])
      mockGetLastManifestSyncTime.mockResolvedValue(0)
      // Both active and deleted items have their base version tracked in the item sync state
      depsObj.itemSyncState.trackedItems.mockReturnValue([
        ['item-active', 100],
        ['item-deleted', 100],
      ])
      mockFetchManifest.mockResolvedValue({
        manifest: [
          { itemId: 'item-active', modifiedAt: 100 },
          { itemId: 'item-deleted', modifiedAt: 100 },
        ],
      })

      const result = await sync(manifestSyncManager)

      expect(mockFetchSnapshotsByIds).not.toHaveBeenCalled()
      expect(mockUpdateLastManifestSyncTime).toHaveBeenCalled()
      expect(result).toMatchObject({ added: [], success: true })
    })

    it('batches missing snapshot fetches in chunks of 50', async () => {
      mockListItemIds.mockResolvedValue([])
      const manifestEntries = Array.from({ length: 120 }, (_, i) => ({
        itemId: `item-${i}`,
        modifiedAt: 100 + i,
      }))
      mockFetchManifest.mockResolvedValue({
        manifest: manifestEntries,
      })

      mockFetchSnapshotsByIds.mockResolvedValue({ items: [] })

      await sync(manifestSyncManager)

      expect(mockFetchSnapshotsByIds).toHaveBeenCalledTimes(3)
      expect(mockFetchSnapshotsByIds).toHaveBeenNthCalledWith(1, {
        account: 'acc-123',
        itemIds: manifestEntries.slice(0, 50).map(e => e.itemId),
        maxResponseChars: MAX_FETCH_RESPONSE_CHARS,
      }, { signal: expect.any(AbortSignal) })
      expect(mockFetchSnapshotsByIds).toHaveBeenNthCalledWith(2, {
        account: 'acc-123',
        itemIds: manifestEntries.slice(50, 100).map(e => e.itemId),
        maxResponseChars: MAX_FETCH_RESPONSE_CHARS,
      }, { signal: expect.any(AbortSignal) })
      expect(mockFetchSnapshotsByIds).toHaveBeenNthCalledWith(3, {
        account: 'acc-123',
        itemIds: manifestEntries.slice(100, 120).map(e => e.itemId),
        maxResponseChars: MAX_FETCH_RESPONSE_CHARS,
      }, { signal: expect.any(AbortSignal) })
    })

    it('throws if fetchManifest fails when known items exist, failing the poll (rule 4)', async () => {
      mockListItemIds.mockResolvedValue(['item-1'])
      mockGetLastManifestSyncTime.mockResolvedValue(0)
      mockFetchManifest.mockRejectedValue(new Error('Network offline'))

      await expect(sync(manifestSyncManager)).rejects.toThrow('Network offline')
    })
  })

  describe('legacy settings migration', () => {
    beforeEach(() => {
      mockFetchManifest.mockResolvedValue({
        manifest: [{ itemId: 'item-1', modifiedAt: 100 }],
      })
      mockListItemIds.mockResolvedValue(['item-1'])
      mockGetLastManifestSyncTime.mockResolvedValue(0)
    })

    it('migrates legacy settings after each manifest sync', async () => {
      await sync(manifestSyncManager)

      expect(migrateLegacySettingsSpy).toHaveBeenCalledTimes(1)
    })

    it('does nothing without a migration hook', async () => {
      const manager = createManager({ ...depsObj, migrateLegacySettings: undefined } as any)

      await expect(sync(manager)).resolves.toMatchObject({ added: [], success: true })
    })

    it('treats a failed migration as non-fatal so it retries on the next sync', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      migrateLegacySettingsSpy.mockRejectedValueOnce(new Error('TRPC error'))

      await expect(sync(manifestSyncManager)).resolves.toMatchObject({ added: [], success: true })
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Legacy settings migration skipped'),
        expect.any(Error),
      )
      warnSpy.mockRestore()
    })
  })

  describe('fetchManifestEverySync', () => {
    it('fetches the manifest even when a sync ran within the day', async () => {
      mockListItemIds.mockResolvedValue(['item-1' as ItemId])
      mockGetLastManifestSyncTime.mockResolvedValue(Date.now() - 1000)
      mockFetchManifest.mockResolvedValue({ manifest: [] })
      const manager = createManager({ ...depsObj, fetchManifestEverySync: true } as any)

      await sync(manager)

      expect(mockFetchManifest).toHaveBeenCalledTimes(1)
    })
  })

  describe('onSyncedWithoutFailures', () => {
    it('is called after a sync in which every item hydrated', async () => {
      const onSyncedWithoutFailures = vi.fn()
      const manager = createManager({ ...depsObj, onSyncedWithoutFailures } as any)
      mockFetchManifest.mockResolvedValue({ manifest: [] })
      mockListItemIds.mockResolvedValue([])

      await expect(sync(manager)).resolves.toMatchObject({ added: [], success: true })
      expect(onSyncedWithoutFailures).toHaveBeenCalledTimes(1)
    })

    it('is called when the sync is skipped because a clean sync ran recently', async () => {
      const onSyncedWithoutFailures = vi.fn()
      const manager = createManager({ ...depsObj, onSyncedWithoutFailures } as any)
      mockListItemIds.mockResolvedValue(['item-1'])
      mockGetLastManifestSyncTime.mockResolvedValue(Date.now() - 1000)

      await expect(sync(manager)).resolves.toMatchObject({ added: [], success: true })
      expect(mockFetchManifest).not.toHaveBeenCalled()
      expect(onSyncedWithoutFailures).toHaveBeenCalledTimes(1)
    })

    it('is not called when an item failed to hydrate', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const onSyncedWithoutFailures = vi.fn()
      const manager = createManager({ ...depsObj, onSyncedWithoutFailures } as any)
      mockListItemIds.mockResolvedValue([])
      mockFetchManifest.mockResolvedValue({
        manifest: [{ itemId: 'item-1', modifiedAt: 100 }],
      })
      mockFetchSnapshotsByIds.mockResolvedValue({ items: [], deferred: ['item-1'] })

      await sync(manager)

      expect(onSyncedWithoutFailures).not.toHaveBeenCalled()
      warnSpy.mockRestore()
      errorSpy.mockRestore()
    })
  })

  describe('lockout prevention on failure', () => {
    it('does NOT update lastManifestSyncTime when a snapshot batch fails to fetch', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      mockListItemIds.mockResolvedValue([])
      mockFetchManifest.mockResolvedValue({
        manifest: [
          { itemId: 'item-1', modifiedAt: 100 },
          { itemId: 'item-2', modifiedAt: 200 },
        ],
      })

      // A batch fails with an error that isn't an outage, so it counts against its items
      mockFetchSnapshotsByIds.mockRejectedValue({ message: 'bad input', data: { httpStatus: 400, code: 'BAD_REQUEST' } })

      await sync(manifestSyncManager)

      expect(mockUpdateLastManifestSyncTime).not.toHaveBeenCalled()
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Some batches or items failed to sync; lastManifestSyncTime not updated')
      )

      consoleSpy.mockRestore()
      warnSpy.mockRestore()
    })

    it('does NOT update lastManifestSyncTime when item hydration throws an error', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      mockListItemIds.mockResolvedValue([])
      mockFetchManifest.mockResolvedValue({
        manifest: [{ itemId: 'item-corrupt', modifiedAt: 100 }],
      })

      mockFetchSnapshotsByIds.mockResolvedValue({
        items: [
          {
            item: 'item-corrupt',
            snapshot: { iv: 'iv-c', cipher: 'c-c' },
          },
        ],
      })

      mockDecryptBytes.mockResolvedValue(new Uint8Array([1, 2]))
      mockHydrateAutomergeDocumentBinary.mockRejectedValue(new Error('CRDT hydration crashed'))

      const result = await sync(manifestSyncManager)

      expect(mockUpdateLastManifestSyncTime).not.toHaveBeenCalled()
      expect(mockAddItemIds).not.toHaveBeenCalled()
      expect(depsObj.itemSyncState.importBaseVersions).not.toHaveBeenCalled()
      expect(result).toMatchObject({ added: [], success: false })
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Some batches or items failed to sync; lastManifestSyncTime not updated')
      )

      consoleSpy.mockRestore()
      warnSpy.mockRestore()
    })

    it('quarantines un-decryptable items to onDecryptionFailure without recording their version', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const onDecryptionFailure = vi.fn()

      const manager = createManager({
        ...(depsObj as any),
        storeItems: storeItemsSpy,
        onDecryptionFailure,
      })

      mockListItemIds.mockResolvedValue([])
      mockFetchManifest.mockResolvedValue({
        manifest: [{ itemId: 'item-undecryptable', modifiedAt: 500 }],
      })

      mockFetchSnapshotsByIds.mockResolvedValue({
        items: [
          {
            item: 'item-undecryptable',
            snapshot: { iv: 'bad-iv', cipher: 'bad-cipher' },
          },
        ],
      })

      // decrypt fails (missing key or corrupted ciphertext)
      mockDecryptBytes.mockResolvedValue(null)

      const result = await sync(manager)

      expect(onDecryptionFailure).toHaveBeenCalledWith(
        'item-undecryptable',
        expect.any(Error),
        undefined,
      )
      // The version MUST NOT be recorded, which would stop the item being fetched again
      expect(depsObj.itemSyncState.importBaseVersions).not.toHaveBeenCalled()
      // Hydration failure prevents updating lastManifestSyncTime
      expect(mockUpdateLastManifestSyncTime).not.toHaveBeenCalled()
      expect(result).toMatchObject({ added: [], success: false })

      warnSpy.mockRestore()
    })

    it('skips quarantined items without a newer server version during routine sync to prevent endless retry loops', async () => {
      mockListItemIds.mockResolvedValue([])
      mockReadManualRecoveryEntries.mockResolvedValue([
        { id: 'item-quarantined', itemId: 'item-quarantined', reason: 'fail', createdAt: 500, serverVersion: 3 },
      ])
      mockFetchManifest.mockResolvedValue({
        // A server clock far ahead of the quarantine time doesn't matter, only the version does
        manifest: [{ itemId: 'item-quarantined', version: 3, modifiedAt: 999_999 }],
      })

      const result = await sync(manifestSyncManager)

      expect(mockFetchSnapshotsByIds).not.toHaveBeenCalled()
      expect(result).toMatchObject({ added: [], success: true })
    })

    it('retries quarantined items when force=true even without newer server timestamps', async () => {
      mockListItemIds.mockResolvedValue([])
      mockReadManualRecoveryEntries.mockResolvedValue([
        { id: 'item-quarantined', itemId: 'item-quarantined', reason: 'fail', createdAt: 500 },
      ])
      mockFetchManifest.mockResolvedValue({
        manifest: [{ itemId: 'item-quarantined', modifiedAt: 500 }],
      })
      mockFetchSnapshotsByIds.mockResolvedValue({
        items: [
          {
            item: 'item-quarantined',
            snapshot: { iv: 'iv-ok', cipher: 'cipher-ok', kver: '1' },
          },
        ],
      })
      mockDecryptBytes.mockResolvedValue(new Uint8Array([1, 2, 3]))

      const result = await sync(manifestSyncManager, 'force')

      expect(mockFetchSnapshotsByIds).toHaveBeenCalledWith({
        account: 'acc-123',
        itemIds: ['item-quarantined'],
        maxResponseChars: MAX_FETCH_RESPONSE_CHARS,
      }, { signal: expect.any(AbortSignal) })
      expect(result).toMatchObject({ added: ['item-quarantined'], success: true })
    })

    it('retries quarantined items when server has a newer version than the one that failed', async () => {
      mockListItemIds.mockResolvedValue([])
      mockReadManualRecoveryEntries.mockResolvedValue([
        { id: 'item-quarantined', itemId: 'item-quarantined', reason: 'fail', createdAt: 500, serverVersion: 3 },
      ])
      mockFetchManifest.mockResolvedValue({
        // A server clock behind the quarantine time doesn't matter, only the version does
        manifest: [{ itemId: 'item-quarantined', version: 4, modifiedAt: 100 }],
      })
      mockFetchSnapshotsByIds.mockResolvedValue({
        items: [
          {
            item: 'item-quarantined',
            snapshot: { iv: 'iv-ok', cipher: 'cipher-ok', kver: '1' },
          },
        ],
      })
      mockDecryptBytes.mockResolvedValue(new Uint8Array([1, 2, 3]))

      const result = await sync(manifestSyncManager)

      expect(mockFetchSnapshotsByIds).toHaveBeenCalledWith({
        account: 'acc-123',
        itemIds: ['item-quarantined'],
        maxResponseChars: MAX_FETCH_RESPONSE_CHARS,
      }, { signal: expect.any(AbortSignal) })
      expect(result).toMatchObject({ added: ['item-quarantined'], success: true })
    })

    it('waits for missing key version before attempting snapshot decryption', async () => {
      mockListItemIds.mockResolvedValue([])
      mockFetchManifest.mockResolvedValue({
        manifest: [{ itemId: 'item-kver', modifiedAt: 500 }],
      })
      mockFetchSnapshotsByIds.mockResolvedValue({
        items: [
          {
            item: 'item-kver',
            snapshot: { iv: 'iv-1', cipher: 'cipher-1', kver: '2' },
          },
        ],
      })

      mockHasVaultKey.mockImplementation(kver => kver !== '2')
      mockWaitForKeyVersion.mockImplementation(async kver => {
        if (kver === '2') {
          mockHasVaultKey.mockReturnValue(true)
          return true
        }
        return false
      })
      mockDecryptBytes.mockResolvedValue(new Uint8Array([9, 8, 7]))

      const result = await sync(manifestSyncManager)

      expect(mockWaitForKeyVersion).toHaveBeenCalledWith('2', 3000)
      expect(mockDecryptBytes).toHaveBeenCalled()
      expect(result).toMatchObject({ added: ['item-kver'], success: true })
    })
  })

  describe('manifest diffing', () => {
    it('uploads pending snapshots before evaluating manifest diffs', async () => {
      depsObj.itemSyncState.dirtyCount = 1
      mockListItemIds.mockResolvedValue(['item-1'])
      mockGetLastManifestSyncTime.mockResolvedValue(0)
      depsObj.itemSyncState.trackedItems.mockReturnValue([['item-1', 100]])
      mockFetchManifest.mockResolvedValue({
        manifest: [{ itemId: 'item-1', modifiedAt: 100 }],
      })

      await sync(manifestSyncManager)

      expect(depsObj.snapshotSchedule.requestNow).toHaveBeenCalledExactlyOnceWith({ pastQuota: false })
      expect(depsObj.snapshotPusher.pushDue).toHaveBeenCalledTimes(1)
      // Otherwise the manifest misses the flushed items and they are pushed a second time
      expect(depsObj.snapshotPusher.pushDue.mock.invocationCallOrder[0])
        .toBeLessThan(mockFetchManifest.mock.invocationCallOrder[0])
    })

    // Otherwise every manifest sync of an account at its quota sends one more batch to be refused
    it('leaves a quota deferral in place, so its pre-upload has nothing due', async () => {
      depsObj.itemSyncState.dirtyCount = 1
      const schedule = new SnapshotSchedule({ state: depsObj.itemSyncState, session: depsObj.session })
      schedule.deferUntil(Date.now() + SYNC_TIMEOUTS.snapshotQuotaRetry)
      let dueAtUpload: boolean | undefined
      depsObj.snapshotPusher.pushDue.mockImplementation(async () => {
        dueAtUpload = schedule.isDue()
        return { persisted: 0, total: 0, success: true }
      })
      mockFetchManifest.mockResolvedValue({ manifest: [] })

      await sync(createManager({ ...depsObj, snapshotSchedule: schedule } as any))

      expect(depsObj.snapshotPusher.pushDue).toHaveBeenCalledTimes(1)
      expect(dueAtUpload).toBe(false)
    })

    it('uploads nothing when no item is dirty', async () => {
      mockListItemIds.mockResolvedValue(['item-1'])
      mockFetchManifest.mockResolvedValue({ manifest: [] })

      await sync(manifestSyncManager)

      expect(depsObj.snapshotPusher.pushDue).not.toHaveBeenCalled()
    })

    it('continues gracefully if uploading pending snapshots throws', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      depsObj.itemSyncState.dirtyCount = 1
      depsObj.snapshotPusher.pushDue.mockRejectedValue(new Error('Flush failed'))

      mockListItemIds.mockResolvedValue(['item-1'])
      mockGetLastManifestSyncTime.mockResolvedValue(0)
      depsObj.itemSyncState.trackedItems.mockReturnValue([['item-1', 100]])
      mockFetchManifest.mockResolvedValue({
        manifest: [{ itemId: 'item-1', modifiedAt: 100 }],
      })

      await expect(sync(manifestSyncManager)).resolves.toMatchObject({ added: [], success: true })
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to flush pending snapshots before sync'),
        expect.any(Error)
      )
      warnSpy.mockRestore()
    })

    it('fails when the upload before the manifest fails as a whole', async () => {
      depsObj.itemSyncState.dirtyCount = 1
      depsObj.snapshotPusher.pushDue.mockRejectedValue(new TypeError('Failed to fetch'))
      mockListItemIds.mockResolvedValue(['item-1'])
      mockGetLastManifestSyncTime.mockResolvedValue(0)

      await expect(sync(manifestSyncManager)).rejects.toThrow('Failed to fetch')
      expect(mockFetchManifest).not.toHaveBeenCalled()
    })

    it('skips fetching when the server version matches the local base version', async () => {
      mockListItemIds.mockResolvedValue(['item-1'])
      mockGetLastManifestSyncTime.mockResolvedValue(0)
      depsObj.itemSyncState.trackedItems.mockReturnValue([['item-1', 5000]])
      mockFetchManifest.mockResolvedValue({
        manifest: [{ itemId: 'item-1', version: 1, modifiedAt: 9000 }],
      })

      const result = await sync(manifestSyncManager)

      expect(mockFetchSnapshotsByIds).not.toHaveBeenCalled()
      expect(result).toMatchObject({ added: [], success: true })
    })

    it('pulls a known item when the server version is newer, whatever the timestamps', async () => {
      mockListItemIds.mockResolvedValue(['item-1'])
      mockGetLastManifestSyncTime.mockResolvedValue(0)
      // The local timestamp is far ahead of the server's, which does not matter
      depsObj.itemSyncState.trackedItems.mockReturnValue([['item-1', 1_250_000]])
      mockFetchManifest.mockResolvedValue({
        manifest: [{ itemId: 'item-1', modifiedAt: 1_050_000, version: 2 }],
      })

      mockFetchSnapshotsByIds.mockResolvedValue({
        items: [
          {
            item: 'item-1',
            snapshot: { iv: 'iv-1', cipher: 'c-1' },
          },
        ],
      })
      mockDecryptBytes.mockResolvedValue(new Uint8Array([1, 2, 3]))

      const result = await sync(manifestSyncManager)

      expect(mockFetchSnapshotsByIds).toHaveBeenCalledWith({
        account: 'acc-123',
        itemIds: ['item-1'],
        maxResponseChars: MAX_FETCH_RESPONSE_CHARS,
      }, { signal: expect.any(AbortSignal) })
      expect(mockHydrateAutomergeDocumentBinary).toHaveBeenCalledWith('item-1', new Uint8Array([1, 2, 3]), { knownToExist: true })
      expect(result).toMatchObject({ added: ['item-1'], success: true })
    })

    it('pushes a dirty item instead of pulling a server snapshot at the same version', async () => {
      mockListItemIds.mockResolvedValue(['item-1'])
      mockGetLastManifestSyncTime.mockResolvedValue(0)
      depsObj.itemSyncState.trackedItems.mockReturnValue([['item-1', 1_980_000]])
      depsObj.itemSyncState.listBaseVersions.mockReturnValue(new Map([['item-1', 1]]))
      depsObj.itemSyncState.isDirty.mockReturnValue(true)
      mockFetchManifest.mockResolvedValue({
        manifest: [{ itemId: 'item-1', version: 1, modifiedAt: 900_000 }],
      })

      const result = await sync(manifestSyncManager)

      expect(mockFetchSnapshotsByIds).not.toHaveBeenCalled()
      expect(result).toMatchObject({ added: [], success: true })
      expect(depsObj.snapshotSchedule.markItemDirty).toHaveBeenCalledWith('item-1', 2000)
    })
  })

  describe('snapshots the device already has', () => {
    const localDoc = Automerge.change(Automerge.init<{ name?: string }>(), d => { d.name = 'local' })
    // The mock key provider decrypts a payload to its `cipher`
    const headsPayload = (heads: string[]) => ({
      iv: 'iv',
      cipher: new TextEncoder().encode(JSON.stringify(heads)),
      kver: '1',
    }) as any
    let onSnapshotCovered: ReturnType<typeof vi.fn>

    beforeEach(() => {
      onSnapshotCovered = vi.fn()
      depsObj.docStore.findHandle = vi.fn().mockResolvedValue({ isReady: () => true, doc: () => localDoc })
      manifestSyncManager = createManager({ ...depsObj, onSnapshotCovered } as any)
      mockListItemIds.mockResolvedValue(['item-1'])
      depsObj.itemSyncState.trackedItems.mockReturnValue([['item-1', 100]])
      mockFetchSnapshotsByIds.mockResolvedValue({ items: [] })
    })

    it('raises the base version instead of fetching when the local doc has the snapshot heads', async () => {
      const heads = Automerge.getHeads(localDoc)
      mockFetchManifest.mockResolvedValue({
        manifest: [{ itemId: 'item-1', version: 3, modifiedAt: 100, heads: headsPayload(heads) }],
      })

      const result = await sync(manifestSyncManager)

      expect(result).toMatchObject({ added: [], success: true })
      expect(mockFetchSnapshotsByIds).not.toHaveBeenCalled()
      expect(mockDecryptBytes).toHaveBeenCalledWith(expect.anything(), 'item-1', 'heads')
      expect(depsObj.itemSyncState.importBaseVersions).toHaveBeenCalledWith([['item-1', 3]])
      expect(onSnapshotCovered).toHaveBeenCalledWith('item-1', heads)
    })

    it('fetches the snapshot when the local doc lacks its heads', async () => {
      const remoteDoc = Automerge.change(Automerge.clone(localDoc), d => { d.name = 'remote' })
      mockFetchManifest.mockResolvedValue({
        manifest: [{ itemId: 'item-1', version: 3, modifiedAt: 100, heads: headsPayload(Automerge.getHeads(remoteDoc)) }],
      })

      await sync(manifestSyncManager)

      expect(mockFetchSnapshotsByIds).toHaveBeenCalled()
      expect(onSnapshotCovered).not.toHaveBeenCalled()
    })

    it('fetches the snapshot when its heads fail to decrypt', async () => {
      mockFetchManifest.mockResolvedValue({
        manifest: [{ itemId: 'item-1', version: 3, modifiedAt: 100, heads: { iv: 'iv', cipher: 'corrupt-cipher', kver: '1' } }],
      })

      await sync(manifestSyncManager)

      expect(mockFetchSnapshotsByIds).toHaveBeenCalled()
    })

    it('fetches the snapshot on a forced sync', async () => {
      mockFetchManifest.mockResolvedValue({
        manifest: [{ itemId: 'item-1', version: 3, modifiedAt: 100, heads: headsPayload(Automerge.getHeads(localDoc)) }],
      })

      await sync(manifestSyncManager, 'force')

      expect(depsObj.docStore.findHandle).not.toHaveBeenCalled()
      expect(mockFetchSnapshotsByIds).toHaveBeenCalled()
    })

    it('still pushes a dirty item whose snapshot it already has', async () => {
      depsObj.itemSyncState.listBaseVersions.mockReturnValue(new Map([['item-1', 1]]))
      depsObj.itemSyncState.isDirty.mockReturnValue(true)
      mockFetchManifest.mockResolvedValue({
        manifest: [{ itemId: 'item-1', version: 3, modifiedAt: 100, heads: headsPayload(Automerge.getHeads(localDoc)) }],
      })

      await sync(manifestSyncManager)

      expect(mockFetchSnapshotsByIds).not.toHaveBeenCalled()
      expect(depsObj.snapshotSchedule.markItemDirty).toHaveBeenCalledWith('item-1', expect.any(Number))
    })

    describe('with pulled changes no snapshot has confirmed', () => {
      const pastGrace = () => Date.now() - SYNC_TIMEOUTS.pulledChangesGrace - 1000

      it('forgets the record once the manifest shows the item deleted', async () => {
        depsObj.itemSyncState.listUnconfirmedPulls.mockReturnValue(new Map([['item-1', Date.now()]]))
        mockFetchManifest.mockResolvedValue({
          manifest: [{ itemId: 'item-1', version: 3, modifiedAt: 100, isDeleted: true }],
        })

        await sync(manifestSyncManager)

        expect(depsObj.itemSyncState.confirmPulledChanges).toHaveBeenCalledWith(['item-1'])
      })

      it('uploads after the grace period when the snapshot has no heads to check', async () => {
        depsObj.itemSyncState.listUnconfirmedPulls.mockReturnValue(new Map([['item-1', pastGrace()]]))
        mockFetchManifest.mockResolvedValue({
          manifest: [{ itemId: 'item-1', version: 1, modifiedAt: 100 }],
        })

        await sync(manifestSyncManager)

        expect(depsObj.snapshotSchedule.markItemDirty).toHaveBeenCalledWith('item-1', expect.any(Number))
        // Kept until a snapshot with heads confirms it
        expect(depsObj.itemSyncState.confirmPulledChanges).not.toHaveBeenCalled()
      })

      it('leaves a snapshot without heads to its author during the grace period', async () => {
        depsObj.itemSyncState.listUnconfirmedPulls.mockReturnValue(new Map([['item-1', Date.now()]]))
        mockFetchManifest.mockResolvedValue({
          manifest: [{ itemId: 'item-1', version: 1, modifiedAt: 100 }],
        })

        await sync(manifestSyncManager)

        expect(depsObj.snapshotSchedule.markItemDirty).not.toHaveBeenCalled()
      })

      it('does not upload an item this device does not hold', async () => {
        mockListItemIds.mockResolvedValue([])
        depsObj.itemSyncState.trackedItems.mockReturnValue([])
        depsObj.itemSyncState.listUnconfirmedPulls.mockReturnValue(new Map([['item-1', pastGrace()]]))
        mockFetchManifest.mockResolvedValue({
          manifest: [{ itemId: 'item-1', version: 1, modifiedAt: 100 }],
        })

        await sync(manifestSyncManager)

        expect(depsObj.snapshotSchedule.markItemDirty).not.toHaveBeenCalledWith('item-1', expect.any(Number))
      })
    })
  })

  describe('Two-Way Manifest Reconciliation (Upstream)', () => {
    it('marks item dirty with 2s debounce when local item is missing entirely from server manifest', async () => {
      mockListItemIds.mockResolvedValue(['item-local-only' as ItemId])
      mockGetLastManifestSyncTime.mockResolvedValue(0)
      depsObj.itemSyncState.trackedItems.mockReturnValue([['item-local-only', 1000]])
      mockFetchManifest.mockResolvedValue({
        manifest: [],
      })

      const result = await sync(manifestSyncManager)

      expect(depsObj.snapshotSchedule.markItemDirty).toHaveBeenCalledWith('item-local-only', 2000)
      expect(result).toMatchObject({ added: [], success: true })
    })

    it('marks item dirty with 2s debounce when local item is newer than server snapshot', async () => {
      const now = Date.now()
      const itemServerTime = now - 120_000 // Server snapshot is 2 minutes old
      const localTime = now // Local was edited just now

      mockListItemIds.mockResolvedValue(['item-newer' as ItemId])
      mockGetLastManifestSyncTime.mockResolvedValue(0)
      depsObj.itemSyncState.trackedItems.mockReturnValue([['item-newer', localTime]])
      depsObj.itemSyncState.listBaseVersions.mockReturnValue(new Map([['item-newer', 1]]))
      depsObj.itemSyncState.isDirty.mockReturnValue(true)
      mockFetchManifest.mockResolvedValue({
        manifest: [{ itemId: 'item-newer', modifiedAt: itemServerTime }],
      })

      const result = await sync(manifestSyncManager)

      expect(depsObj.snapshotSchedule.markItemDirty).toHaveBeenCalledWith('item-newer', 2000)
      expect(result).toMatchObject({ added: [], success: true })
    })

    it('does not mark item dirty when local item is equal to or older than server snapshot', async () => {
      const serverTime = 500_000

      mockListItemIds.mockResolvedValue(['item-synced' as ItemId])
      mockGetLastManifestSyncTime.mockResolvedValue(0)
      depsObj.itemSyncState.trackedItems.mockReturnValue([['item-synced', serverTime]])
      mockFetchManifest.mockResolvedValue({
        manifest: [{ itemId: 'item-synced', modifiedAt: serverTime }],
      })

      const result = await sync(manifestSyncManager)

      expect(depsObj.snapshotSchedule.markItemDirty).not.toHaveBeenCalled()
      expect(result).toMatchObject({ added: [], success: true })
    })

    it('does not mark item dirty upstream if it is currently being pulled downstream in missingIds', async () => {
      mockListItemIds.mockResolvedValue(['item-pulling' as ItemId])
      mockGetLastManifestSyncTime.mockResolvedValue(0)
      depsObj.itemSyncState.trackedItems.mockReturnValue([['item-pulling', 0]])
      mockFetchManifest.mockResolvedValue({
        manifest: [{ itemId: 'item-pulling', modifiedAt: 2000 }],
      })
      mockFetchSnapshotsByIds.mockResolvedValue({
        items: [
          {
            item: 'item-pulling',
            snapshot: { iv: 'iv', cipher: 'c' },
          },
        ],
      })
      mockDecryptBytes.mockResolvedValue(new Uint8Array([1]))

      await sync(manifestSyncManager)

      expect(depsObj.snapshotSchedule.markItemDirty).not.toHaveBeenCalled()
    })

    it('only records versions for the items it fetched (B5 fix)', async () => {
      mockListItemIds.mockResolvedValue(['item-offline' as ItemId])
      mockGetLastManifestSyncTime.mockResolvedValue(0)
      // Existing item in snapshot manager with local edits
      depsObj.itemSyncState.trackedItems.mockReturnValue([['item-offline', 5000]])

      mockFetchManifest.mockResolvedValue({
        manifest: [
          { itemId: 'item-offline', modifiedAt: 2000 }, // older on server, so it won't be fetched
          { itemId: 'item-server', modifiedAt: 3000 },  // missing locally, so it will be fetched
        ],
      })

      mockFetchSnapshotsByIds.mockResolvedValue({
        items: [
          {
            item: 'item-server',
            snapshot: { iv: 'iv', cipher: 'c' },
          },
        ],
      })
      mockDecryptBytes.mockResolvedValue(new Uint8Array([1, 2, 3]))

      await sync(manifestSyncManager)

      // Only item-server's version is recorded, never item-offline's
      expect(depsObj.itemSyncState.importBaseVersions).toHaveBeenCalledTimes(1)
      expect(depsObj.itemSyncState.importBaseVersions).toHaveBeenCalledWith([
        ['item-server', 1],
      ])
    })

    it('marks item dirty upstream when hydration merges local edits (hasLocalChanges is true)', async () => {
      mockListItemIds.mockResolvedValue(['item-merged' as ItemId])
      mockGetLastManifestSyncTime.mockResolvedValue(0)
      depsObj.itemSyncState.trackedItems.mockReturnValue([['item-merged', 1000]])
      mockFetchManifest.mockResolvedValue({
        manifest: [{ itemId: 'item-merged', modifiedAt: 2000, version: 2 }],
      })
      mockFetchSnapshotsByIds.mockResolvedValue({
        items: [
          {
            item: 'item-merged',
            snapshot: { iv: 'iv', cipher: 'c' },
          },
        ],
      })
      mockDecryptBytes.mockResolvedValue(new Uint8Array([1, 2, 3]))
      mockHydrateAutomergeDocumentBinary.mockResolvedValue({
        hasLocalChanges: true,
        incomingHeads: ['remote-head-1'],
      })

      const result = await sync(manifestSyncManager)

      expect(depsObj.snapshotSchedule.markItemDirty).toHaveBeenCalledWith('item-merged', 2000)
      expect(result).toMatchObject({ added: ['item-merged'], success: true })
    })

    it('does not mark item dirty and records its version when hydration has no local edits (hasLocalChanges is false)', async () => {
      mockListItemIds.mockResolvedValue(['item-clean' as ItemId])
      mockGetLastManifestSyncTime.mockResolvedValue(0)
      depsObj.itemSyncState.trackedItems.mockReturnValue([['item-clean', 1000]])
      mockFetchManifest.mockResolvedValue({
        manifest: [{ itemId: 'item-clean', modifiedAt: 2000, version: 2 }],
      })
      mockFetchSnapshotsByIds.mockResolvedValue({
        items: [
          {
            item: 'item-clean',
            snapshot: { iv: 'iv', cipher: 'c' },
          },
        ],
      })
      mockDecryptBytes.mockResolvedValue(new Uint8Array([1, 2, 3]))
      mockHydrateAutomergeDocumentBinary.mockResolvedValue({
        hasLocalChanges: false,
        incomingHeads: ['remote-head-1'],
      })

      const result = await sync(manifestSyncManager)

      expect(depsObj.snapshotSchedule.markItemDirty).not.toHaveBeenCalled()
      expect(depsObj.itemSyncState.importBaseVersions).toHaveBeenCalledWith([
        ['item-clean', 2],
      ])
      expect(result).toMatchObject({ added: ['item-clean'], success: true })
    })

    it('on initial login, skips snapshot downloads for tombstoned items and records their versions', async () => {
      // Fresh client: no local items, no timestamps
      mockListItemIds.mockResolvedValue([])
      mockGetLastManifestSyncTime.mockResolvedValue(0)
      depsObj.itemSyncState.trackedItems.mockReturnValue([])

      mockFetchManifest.mockResolvedValue({
        manifest: [
          { itemId: 'item-active-1', modifiedAt: 1000 },
          { itemId: 'item-tombstone-1', modifiedAt: 2000, isDeleted: true },
          { itemId: 'item-tombstone-2', modifiedAt: 3000, isDeleted: true },
        ],
      })

      mockFetchSnapshotsByIds.mockResolvedValue({
        items: [
          {
            item: 'item-active-1',
            snapshot: { iv: 'iv-act', cipher: 'c-act' },
          },
        ],
      })
      mockDecryptBytes.mockResolvedValue(new Uint8Array([1, 2, 3]))
      mockHydrateAutomergeDocumentBinary.mockResolvedValue({
        hasLocalChanges: false,
        incomingHeads: ['head-1'],
      })

      const result = await sync(manifestSyncManager)

      // CRITICAL: fetchSnapshotsByIds must ONLY be called for active items, NEVER for tombstoned items
      expect(mockFetchSnapshotsByIds).toHaveBeenCalledWith({
        account: 'acc-123',
        itemIds: ['item-active-1'],
        maxResponseChars: MAX_FETCH_RESPONSE_CHARS,
      }, { signal: expect.any(AbortSignal) })

      // Versions for tombstones are recorded so future syncs don't record them again
      expect(depsObj.itemSyncState.importBaseVersions).toHaveBeenCalledWith(
        expect.arrayContaining([
          ['item-tombstone-1', 1],
          ['item-tombstone-2', 1],
        ])
      )

      expect(storeItemsSpy).not.toHaveBeenCalled()
      expect(result).toMatchObject({ added: ['item-active-1'], success: true })
    })

    it('tombstones local active item when server manifest marks it deleted, without snapshot download or upstream resurrection', async () => {
      // Client has item-local active locally
      mockListItemIds.mockResolvedValue(['item-local' as ItemId])
      mockGetLastManifestSyncTime.mockResolvedValue(0)
      depsObj.itemSyncState.trackedItems.mockReturnValue([['item-local', 1000]])

      mockFetchManifest.mockResolvedValue({
        manifest: [
          { itemId: 'item-local', modifiedAt: 2000, isDeleted: true },
        ],
      })

      const result = await sync(manifestSyncManager)

      // Must NOT fetch snapshot payload for deleted item
      expect(mockFetchSnapshotsByIds).not.toHaveBeenCalled()

      // Must store tombstone locally with markDirty: false
      expect(storeItemsSpy).toHaveBeenCalledWith(
        [{ id: 'item-local', deleted: true }],
        { markDirty: false }
      )

      // Must NOT push item-local upstream
      expect(depsObj.snapshotSchedule.markItemDirty).not.toHaveBeenCalled()

      // Must delete from dirtyItems to prevent unintentional resurrection/upload
      expect(depsObj.snapshotSchedule.deleteDirtyItem).toHaveBeenCalledWith('item-local')

      // Must record the server's version
      expect(depsObj.itemSyncState.importBaseVersions).toHaveBeenCalledWith([
        ['item-local', 1],
      ])

      expect(result).toMatchObject({ added: [], success: true })
    })

    it('does NOT fetch or resurrect locally tombstoned items during forced sync when server has older active snapshot (C5 fix)', async () => {
      // Local client has item-deleted in tombstoneIds (not in active itemIds)
      mockListItemIds.mockResolvedValue(['item-active' as ItemId])
      mockListTombstoneIds.mockResolvedValue(['item-deleted' as ItemId])
      mockGetLastManifestSyncTime.mockResolvedValue(0)
      depsObj.itemSyncState.trackedItems.mockReturnValue([
        ['item-active', 100],
        ['item-deleted', 500],
      ])

      // Server manifest has an older active snapshot for item-deleted (isDeleted is undefined)
      mockFetchManifest.mockResolvedValue({
        manifest: [
          { itemId: 'item-active', modifiedAt: 100 },
          { itemId: 'item-deleted', modifiedAt: 200 },
        ],
      })

      const result = await sync(manifestSyncManager, 'force')

      // Must NOT fetch snapshot payload for tombstoned item
      expect(mockFetchSnapshotsByIds).not.toHaveBeenCalled()
      // Must NOT add tombstoned item to active items
      expect(result?.added).toEqual([])
      expect(mockAddItemIds).not.toHaveBeenCalled()
      // Local tombstone is newer than server active snapshot, so must push tombstone upstream
      expect(depsObj.snapshotSchedule.markItemDirty).toHaveBeenCalledWith('item-deleted', 2000)
    })

    it('fetches an item with a base version but no index entry, and a merge keeps a local deletion', async () => {
      // Only the index's tombstones say an item was deleted; a base version alone says nothing
      mockListItemIds.mockResolvedValue(['item-active' as ItemId])
      mockListTombstoneIds.mockResolvedValue([])
      mockGetLastManifestSyncTime.mockResolvedValue(0)
      depsObj.itemSyncState.trackedItems.mockReturnValue([
        ['item-active', 100],
        ['item-unindexed', 500],
      ])

      mockFetchManifest.mockResolvedValue({
        manifest: [
          { itemId: 'item-active', modifiedAt: 100 },
          { itemId: 'item-unindexed', modifiedAt: 200 },
        ],
      })
      mockFetchSnapshotsByIds.mockResolvedValue({
        items: [{ item: 'item-unindexed', snapshot: { iv: 'iv', cipher: 'c' } }],
      })
      mockDecryptBytes.mockResolvedValue(new Uint8Array([1, 2, 3]))
      // The local doc was deleted, and the merge keeps it deleted (sync rule 2)
      mockHydrateAutomergeDocumentBinary.mockResolvedValue({
        hasLocalChanges: true,
        incomingHeads: ['head-1'],
        isDeleted: true,
      })

      const result = await sync(manifestSyncManager, 'force')

      expect(mockFetchSnapshotsByIds).toHaveBeenCalledWith(
        expect.objectContaining({ itemIds: ['item-unindexed'] }),
        expect.anything(),
      )
      expect(result?.added).toEqual([])
      expect(mockAddItemIds).not.toHaveBeenCalled()
      expect(mockRemoveItemIds).toHaveBeenCalledWith(['item-unindexed'])
    })

    it('does NOT add fetched snapshot to hydratedIds or active index if resulting document is deleted (C5 fix)', async () => {
      mockListItemIds.mockResolvedValue([])
      mockGetLastManifestSyncTime.mockResolvedValue(0)
      depsObj.itemSyncState.trackedItems.mockReturnValue([])

      mockFetchManifest.mockResolvedValue({
        manifest: [{ itemId: 'item-merged-deleted', modifiedAt: 2000 }],
      })

      mockFetchSnapshotsByIds.mockResolvedValue({
        items: [
          {
            item: 'item-merged-deleted',
            snapshot: { iv: 'iv', cipher: 'c' },
          },
        ],
      })
      mockDecryptBytes.mockResolvedValue(new Uint8Array([1, 2, 3]))
      mockHydrateAutomergeDocumentBinary.mockResolvedValue({
        hasLocalChanges: true,
        incomingHeads: ['head-1'],
        isDeleted: true,
      })

      const result = await sync(manifestSyncManager)

      expect(mockAddItemIds).not.toHaveBeenCalled()
      expect(mockRemoveItemIds).toHaveBeenCalledWith(['item-merged-deleted'])
      expect(depsObj.snapshotSchedule.markItemDirty).toHaveBeenCalledWith('item-merged-deleted', 2000)
      expect(result?.added).toEqual([])
    })

    it('does NOT overwrite local tombstone when fetched legacy cipher snapshot is not deleted (C5 fix)', async () => {
      mockListItemIds.mockResolvedValue([])
      mockListTombstoneIds.mockResolvedValue(['item-legacy-tombstone' as ItemId])
      mockGetLastManifestSyncTime.mockResolvedValue(0)
      depsObj.itemSyncState.trackedItems.mockReturnValue([['item-legacy-tombstone', 1000]])

      // Suppose item was fetched in batch
      mockFetchManifest.mockResolvedValue({
        manifest: [{ itemId: 'item-legacy-tombstone', modifiedAt: 500 }],
      })

      mockFetchSnapshotsByIds.mockResolvedValue({
        items: [
          {
            item: 'item-legacy-tombstone',
            cipher: 'cipher-text',
            metadata: { iv: 'iv-text' },
          },
        ],
      })
      const decodeLegacyItem = vi.fn().mockResolvedValue({ id: 'item-legacy-tombstone', name: 'Zombie' })
      const manager = createManager({ ...depsObj, decodeLegacyItem } as any)

      // Force item into missingIds by testing hydration directly or when pulled
      // In normal flow, tombstoneSet skips download. But if download happens:
      // We test that the legacy decoding branch guards against resurrecting item-legacy-tombstone
      // We can verify this by checking that storeItems is never called with the non-deleted zombie item
      const result = await sync(manager)

      expect(storeItemsSpy).not.toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ id: 'item-legacy-tombstone' })]),
        expect.anything()
      )
      expect(result?.added).toEqual([])
    })
  })

  describe('discrete steps unit tests', () => {
    describe('pushLocalUpdates', () => {
      it('stores local tombstones, records versions, and marks upstream dirty when passed SyncDeltas', async () => {
        await manifestSyncManager['pushLocalUpdates']({
          missingIds: [],
          upstreamIds: ['item-up-1' as ItemId, 'item-up-2' as ItemId],
          locallyTombstonedSnapshots: [{ id: 'item-tomb-1', deleted: true } as any],
          deletedVersionUpdates: [['item-tomb-1' as ItemId, 3]],
          knownSet: new Set(),
          tombstoneSet: new Set(),
        })

        expect(storeItemsSpy).toHaveBeenCalledWith(
          [{ id: 'item-tomb-1', deleted: true }],
          { markDirty: false },
        )
        expect(depsObj.snapshotSchedule.deleteDirtyItem).toHaveBeenCalledWith('item-tomb-1')
        expect(depsObj.itemSyncState.importBaseVersions).toHaveBeenCalledWith([
          ['item-tomb-1', 3],
        ])
        expect(depsObj.snapshotSchedule.markItemDirty).toHaveBeenCalledWith('item-up-1', 2000)
        expect(depsObj.snapshotSchedule.markItemDirty).toHaveBeenCalledWith('item-up-2', 2000)
      })

      it('calls deleteDirtyItem on server-deleted items even if storeItems throws', async () => {
        storeItemsSpy.mockRejectedValueOnce(new Error('Storage failure'))

        await expect(
          manifestSyncManager['pushLocalUpdates']({
            missingIds: [],
            upstreamIds: [],
            locallyTombstonedSnapshots: [{ id: 'item-fail-1', deleted: true } as any],
            deletedVersionUpdates: [['item-fail-1' as ItemId, 3]],
            knownSet: new Set(),
            tombstoneSet: new Set(),
          }),
        ).rejects.toThrow('Storage failure')

        expect(depsObj.snapshotSchedule.deleteDirtyItem).toHaveBeenCalledWith('item-fail-1')
      })

    })

    describe('cancellation and shutdown', () => {
      it('returns early when pre-aborted signal is provided', async () => {
        const controller = new AbortController()
        controller.abort()

        await expect(sync(manifestSyncManager, 'force', controller.signal)).rejects.toThrow()

        expect(mockFetchManifest).not.toHaveBeenCalled()
      })

      it('returns early without work once the session is shutting down', async () => {
        depsObj.session.markShutdown()

        expect(await sync(manifestSyncManager, 'force')).toBeNull()

        expect(mockFetchManifest).not.toHaveBeenCalled()
      })

      it('aborts in-flight manifest fetch when aborted externally', async () => {
        const controller = new AbortController()
        mockFetchManifest.mockImplementation(async (_input: any, options?: { signal?: AbortSignal }) => {
          return new Promise((resolve, reject) => {
            if (options?.signal) {
              options.signal.addEventListener('abort', () => {
                const err = new Error('Aborted')
                err.name = 'AbortError'
                reject(err)
              })
            }
          })
        })

        const syncPromise = sync(manifestSyncManager, 'force', controller.signal)
        await vi.waitFor(() => expect(mockFetchManifest).toHaveBeenCalled())
        controller.abort()

        await expect(syncPromise).rejects.toThrow()
      })

      it('stops before fetching snapshots when the poll is aborted after the manifest arrives', async () => {
        const controller = new AbortController()
        mockFetchManifest.mockImplementation(async () => {
          controller.abort()
          return {
            manifest: [{ itemId: 'item-remote-1', modifiedAt: 1000 }],
          }
        })

        await expect(sync(manifestSyncManager, 'force', controller.signal)).rejects.toThrow()
        expect(mockFetchSnapshotsByIds).not.toHaveBeenCalled()
      })

      it('stops before fetching snapshots when the session shuts down during the manifest fetch', async () => {
        mockFetchManifest.mockImplementation(async () => {
          depsObj.session.markShutdown()
          return {
            manifest: [{ itemId: 'item-remote-1', modifiedAt: 1000 }],
          }
        })

        await expect(sync(manifestSyncManager, 'force')).rejects.toThrow()
        expect(mockFetchSnapshotsByIds).not.toHaveBeenCalled()
      })
    })
  })
})


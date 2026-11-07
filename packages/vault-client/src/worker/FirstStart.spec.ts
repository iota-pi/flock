import type { Mock } from 'vitest'
import * as Automerge from '@automerge/automerge/slim'
import { IDBFactory } from 'fake-indexeddb'
import type { ItemId, ManifestEntry } from '@vault/shared'
import type { KeyProvider } from '../keys/Keyring'
import { encryptSnapshotHeads } from './snapshotHeads'
import { createAccountKeys } from './__test__/syncLogHarness'
import { createMockLocalForagePool, mockLocalForage } from './__test__/testUtils'
import { FirstStart, runFirstStartLocalPart, type FirstStartDeps } from './FirstStart'
import { ServerHeads } from './ServerHeads'
import { SyncLogDatabase } from './stores/SyncLogDatabase'
import { getSyncMetadataStorage, SYNC_METADATA_KEYS } from './stores/syncMetadataStorage'
import { SYNC_LOG_STORES } from '../shared/syncLogStorage'
import { clearAccountStoreInstancesCacheForTesting } from '../shared/createAccountStore'
import * as writeAheadLogStorage from '../shared/writeAheadLogStorage'
import { spyOnExports } from '../../test/moduleMocks'

type AnyMock = Mock<(...args: any[]) => any>

const ACCOUNT = 'account-1'
const ITEM = 'item-1' as ItemId

const doc = Automerge.change(Automerge.init<{ title?: string }>(), d => { d.title = 'base' })
const docHeads = Automerge.getHeads(doc)

describe('first start', () => {
  let db: SyncLogDatabase

  beforeEach(() => {
    vi.stubGlobal('indexedDB', new IDBFactory())
    clearAccountStoreInstancesCacheForTesting()
    mockLocalForage(createMockLocalForagePool().createInstance)
    db = new SyncLogDatabase(ACCOUNT)
  })

  afterEach(async () => {
    await db.close()
  })

  describe('local part', () => {
    const storage = () => getSyncMetadataStorage(ACCOUNT)

    it('records every item, marks it pending, and clears the old sync state', async () => {
      await storage().setItem(SYNC_METADATA_KEYS.SYNCED_HEADS, [[ITEM, ['old']]])
      await storage().setItem(SYNC_METADATA_KEYS.CURSORS, { globalCursor: 5 })

      await runFirstStartLocalPart(ACCOUNT, async () => [ITEM])

      expect(await db.getAll(SYNC_LOG_STORES.firstStart)).toEqual([{ itemId: ITEM, state: 'awaitingHeads' }])
      expect(await db.getAll(SYNC_LOG_STORES.outbox)).toEqual([expect.objectContaining({ itemId: ITEM })])
      expect(await storage().getItem(SYNC_METADATA_KEYS.SYNCED_HEADS)).toBeNull()
      expect(await storage().getItem(SYNC_METADATA_KEYS.CURSORS)).toBeNull()
      expect(await storage().getItem(SYNC_METADATA_KEYS.FIRST_START_RESET)).toBe(true)
    })

    it('never runs twice, so a later tab can\'t clear heads the leader has set', async () => {
      await runFirstStartLocalPart(ACCOUNT, async () => [ITEM])
      await storage().setItem(SYNC_METADATA_KEYS.SYNCED_HEADS, [[ITEM, ['from the leader']]])
      const listItemIds = vi.fn(async () => [ITEM])

      await runFirstStartLocalPart(ACCOUNT, listItemIds)

      expect(listItemIds).not.toHaveBeenCalled()
      expect(await storage().getItem(SYNC_METADATA_KEYS.SYNCED_HEADS)).toEqual([[ITEM, ['from the leader']]])
    })

    it('repeats safely after being interrupted', async () => {
      await expect(runFirstStartLocalPart(ACCOUNT, async () => {
        throw new Error('interrupted')
      })).rejects.toThrow('interrupted')
      expect(await storage().getItem(SYNC_METADATA_KEYS.FIRST_START_RESET)).toBeNull()

      await runFirstStartLocalPart(ACCOUNT, async () => [ITEM])

      expect(await db.count(SYNC_LOG_STORES.firstStart)).toBe(1)
    })
  })

  describe('network part', () => {
    let keys: KeyProvider
    let serverHeads: ServerHeads
    let requestSnapshot: AnyMock
    let syncManifest: AnyMock
    let pushPending: AnyMock
    let getBaseVersion: AnyMock
    let isDirty: AnyMock
    let findHandle: AnyMock
    let listRecoveryItems: AnyMock
    let onManifestSynced: AnyMock
    let clearWriteAheadLog: AnyMock
    let firstStart: FirstStart

    async function start(records: ItemId[] = [ITEM]): Promise<void> {
      await runFirstStartLocalPart(ACCOUNT, async () => records)
      await firstStart.load()
    }

    function entry(overrides: Partial<ManifestEntry> = {}): ManifestEntry {
      return { itemId: ITEM, version: 2, modifiedAt: 1, ...overrides }
    }

    beforeEach(async () => {
      keys = await createAccountKeys()
      serverHeads = new ServerHeads({ loadSyncedHeads: async () => [], saveSyncedHeads: async () => {} })
      requestSnapshot = vi.fn()
      syncManifest = vi.fn().mockResolvedValue(true)
      pushPending = vi.fn().mockResolvedValue(undefined)
      getBaseVersion = vi.fn().mockReturnValue(0)
      isDirty = vi.fn().mockReturnValue(false)
      findHandle = vi.fn().mockResolvedValue({ isReady: () => true, doc: () => doc })
      listRecoveryItems = vi.fn().mockResolvedValue([])
      onManifestSynced = vi.fn()
      clearWriteAheadLog = vi.fn().mockResolvedValue(undefined)
      spyOnExports(writeAheadLogStorage, { clearWriteAheadLog })
      firstStart = new FirstStart({
        accountId: ACCOUNT,
        db,
        keys,
        docStore: { findHandle } as unknown as FirstStartDeps['docStore'],
        recoveryManager: { listRecoveryItems } as unknown as FirstStartDeps['recoveryManager'],
        serverHeads,
        syncManifest,
        pushPending,
        getBaseVersion,
        requestSnapshot,
        isDirty,
        onManifestSynced,
      })
    })

    afterEach(async () => {
      await serverHeads.shutdown({ clearLocalData: true })
    })

    describe('resolving an item from its manifest entry', () => {
      it('takes heads the doc has as server heads', async () => {
        await start()

        await firstStart.onManifestProcessed([entry({ heads: await encryptSnapshotHeads(keys, ITEM, docHeads) })])

        expect(serverHeads.get(ITEM)).toEqual(docHeads)
        expect(firstStart.has(ITEM)).toBe(false)
        expect(await db.count(SYNC_LOG_STORES.firstStart)).toBe(0)
        expect(requestSnapshot).not.toHaveBeenCalled()
      })

      it('asks for a snapshot of a doc holding more than the snapshot', async () => {
        await start()
        const older = Automerge.change(Automerge.init<{ title?: string }>(), d => { d.title = 'older' })
        const merged = Automerge.merge(Automerge.clone(doc), older)
        findHandle.mockResolvedValue({ isReady: () => true, doc: () => merged })

        await firstStart.onManifestProcessed([entry({ heads: await encryptSnapshotHeads(keys, ITEM, docHeads) })])

        expect(requestSnapshot).toHaveBeenCalledWith(ITEM)
        expect(firstStart.has(ITEM)).toBe(false)
      })

      it('waits when the doc lacks the heads', async () => {
        await start()
        const unknown = ['a'.repeat(64)]

        await firstStart.onManifestProcessed([entry({ heads: await encryptSnapshotHeads(keys, ITEM, unknown) })])

        expect(firstStart.stateOf(ITEM)).toBe('awaitingHeads')
        expect(serverHeads.has(ITEM)).toBe(false)
      })

      it('moves an item the manifest lacks to its own snapshot', async () => {
        await start()

        await firstStart.onManifestProcessed([])

        expect(firstStart.stateOf(ITEM)).toBe('awaitingSnapshot')
        expect(await db.getAll(SYNC_LOG_STORES.firstStart)).toEqual([{ itemId: ITEM, state: 'awaitingSnapshot' }])
        expect(requestSnapshot).toHaveBeenCalledWith(ITEM)
      })

      it('moves an item with no heads to its own snapshot once the doc has merged that snapshot', async () => {
        await start()
        getBaseVersion.mockReturnValue(2)

        await firstStart.onManifestProcessed([entry()])

        expect(firstStart.stateOf(ITEM)).toBe('awaitingSnapshot')
      })

      it('waits on an item with no heads whose snapshot has not merged', async () => {
        await start()
        getBaseVersion.mockReturnValue(1)

        await firstStart.onManifestProcessed([entry()])

        expect(firstStart.stateOf(ITEM)).toBe('awaitingHeads')
        expect(requestSnapshot).not.toHaveBeenCalled()
      })

      it('treats malformed heads and failed decryption like no heads', async () => {
        await start()
        getBaseVersion.mockReturnValue(2)
        const malformed = await keys.encryptBytes(new TextEncoder().encode('{"not":"heads"}'), ITEM, 'heads')

        await firstStart.onManifestProcessed([entry({ heads: malformed })])

        expect(firstStart.stateOf(ITEM)).toBe('awaitingSnapshot')
      })

      it('waits on a missing key, and resolves after a keyring update', async () => {
        await start()
        const heads = await encryptSnapshotHeads(keys, ITEM, docHeads)
        const hasKey = vi.spyOn(keys, 'hasKey').mockReturnValue(false)

        await firstStart.onManifestProcessed([entry({ heads })])
        expect(firstStart.stateOf(ITEM)).toBe('awaitingHeads')

        hasKey.mockRestore()
        firstStart.onKeyringUpdated()
        await vi.waitFor(() => expect(firstStart.has(ITEM)).toBe(false))
        expect(serverHeads.get(ITEM)).toEqual(docHeads)
      })

      it('leaves a quarantined item to recovery', async () => {
        await start()
        listRecoveryItems.mockResolvedValue([{ itemId: ITEM }])

        await firstStart.onManifestProcessed([])

        expect(firstStart.stateOf(ITEM)).toBe('awaitingHeads')
      })

      it('forgets a deleted item', async () => {
        await start()

        await firstStart.onManifestProcessed([entry({ isDeleted: true })])

        expect(firstStart.has(ITEM)).toBe(false)
      })
    })

    describe('snapshots', () => {
      it('takes a confirmed snapshot\'s heads as server heads', async () => {
        await start()
        await firstStart.onManifestProcessed([])

        await firstStart.onSnapshotConfirmed(ITEM, docHeads)

        expect(serverHeads.get(ITEM)).toEqual(docHeads)
        expect(firstStart.has(ITEM)).toBe(false)
      })

      it('removes the record for a confirmed tombstone, which has no heads', async () => {
        await start()
        await firstStart.onManifestProcessed([])

        await firstStart.onSnapshotConfirmed(ITEM, undefined)

        expect(serverHeads.has(ITEM)).toBe(false)
        expect(firstStart.has(ITEM)).toBe(false)
      })

      it('ignores an item still waiting for its heads', async () => {
        await start()

        await firstStart.onSnapshotConfirmed(ITEM, docHeads)

        expect(firstStart.stateOf(ITEM)).toBe('awaitingHeads')
      })

      it('asks again for a snapshot whose dirty flag was lost', async () => {
        await start()
        await firstStart.onManifestProcessed([])
        requestSnapshot.mockClear()

        await firstStart.onManifestProcessed([])

        expect(requestSnapshot).toHaveBeenCalledWith(ITEM)
      })
    })

    it('runs the manifest sync, pushes, then records that it finished', async () => {
      await start()
      const order: string[] = []
      syncManifest.mockImplementation(async () => {
        order.push('manifest')
        return true
      })
      pushPending.mockImplementation(async () => {
        order.push(`push, can push: ${firstStart.canPush}`)
      })

      await firstStart.ensureSynced()

      expect(order).toEqual(['manifest', 'push, can push: true'])
      expect(onManifestSynced).toHaveBeenCalledTimes(1)
      expect(await getSyncMetadataStorage(ACCOUNT).getItem(SYNC_METADATA_KEYS.FIRST_START_SYNCED)).toBe(true)
      expect(firstStart.synced).toBe(true)
      await firstStart.whenReadyToPush()
    })

    it('blocks pushes until the manifest sync has run', async () => {
      await start()

      expect(firstStart.canPush).toBe(false)
    })

    it('fails when the manifest can\'t be fetched, and a later poll retries', async () => {
      await start()
      syncManifest.mockResolvedValueOnce(false)

      await expect(firstStart.ensureSynced()).rejects.toThrow('manifest')
      expect(pushPending).not.toHaveBeenCalled()

      await firstStart.ensureSynced()
      expect(pushPending).toHaveBeenCalledTimes(1)
    })

    it('repeats after a failed push, keeping what it resolved', async () => {
      await start()
      pushPending.mockRejectedValueOnce(new Error('offline'))

      await expect(firstStart.ensureSynced()).rejects.toThrow('offline')
      expect(await getSyncMetadataStorage(ACCOUNT).getItem(SYNC_METADATA_KEYS.FIRST_START_SYNCED)).toBeNull()

      await firstStart.ensureSynced()
      expect(syncManifest).toHaveBeenCalledTimes(2)
    })

    it('allows pushes once the manifest sync has run, even while its push keeps failing', async () => {
      await start()
      pushPending.mockRejectedValue(new Error('BAD_REQUEST'))

      await expect(firstStart.ensureSynced()).rejects.toThrow('BAD_REQUEST')

      await firstStart.whenReadyToPush()
      expect(firstStart.canPush).toBe(true)
      expect(firstStart.synced).toBe(false)
    })

    it('records why the network part failed, until it finishes', async () => {
      await start()
      pushPending.mockRejectedValueOnce(new Error('The server refused item x'))

      await expect(firstStart.ensureSynced()).rejects.toThrow()
      expect(firstStart.error).toBe('The server refused item x')

      await firstStart.ensureSynced()
      expect(firstStart.error).toBeNull()
    })

    it('runs once, and skips the work for a device that has finished', async () => {
      await start()
      await firstStart.ensureSynced()

      await firstStart.ensureSynced()
      expect(syncManifest).toHaveBeenCalledTimes(1)
    })

    it('honours the caller\'s signal while waiting', async () => {
      await start()
      const controller = new AbortController()
      const waiting = firstStart.whenReadyToPush(controller.signal)

      controller.abort()

      await expect(waiting).rejects.toThrow()
    })

    describe('the write-ahead log', () => {
      it('clears the WAL once, recording that it did', async () => {
        await start()

        await firstStart.ensureSynced()

        await vi.waitFor(async () => {
          expect(await getSyncMetadataStorage(ACCOUNT).getItem(SYNC_METADATA_KEYS.WAL_CLEARED)).toBe(true)
        })
        expect(clearWriteAheadLog).toHaveBeenCalledWith(ACCOUNT)
      })

      it('leaves a failed clear for the next start, without failing first start', async () => {
        await start()
        clearWriteAheadLog.mockRejectedValueOnce(new Error('blocked'))

        await firstStart.ensureSynced()
        await vi.waitFor(() => expect(clearWriteAheadLog).toHaveBeenCalledTimes(1))
        expect(await getSyncMetadataStorage(ACCOUNT).getItem(SYNC_METADATA_KEYS.WAL_CLEARED)).toBeNull()

        const nextStart = new FirstStart({
          accountId: ACCOUNT,
          db,
          keys,
          docStore: { findHandle } as unknown as FirstStartDeps['docStore'],
          recoveryManager: { listRecoveryItems } as unknown as FirstStartDeps['recoveryManager'],
          serverHeads,
          syncManifest,
          pushPending,
          getBaseVersion,
          requestSnapshot,
          isDirty,
          onManifestSynced,
        })
        await nextStart.load()
        await nextStart.ensureSynced()

        await vi.waitFor(() => expect(clearWriteAheadLog).toHaveBeenCalledTimes(2))
      })
    })
  })
})

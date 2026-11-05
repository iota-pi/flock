import type { Mock } from 'vitest'
import * as Automerge from '@automerge/automerge/slim'
import { IDBFactory } from 'fake-indexeddb'
import type { ItemId } from '@vault/shared'
import { ServerHeads } from './ServerHeads'
import { SnapshotCoverage } from './SnapshotCoverage'
import type { FirstStartState } from './FirstStart'
import { SyncLogDatabase } from './stores/SyncLogDatabase'

type AnyMock = Mock<(...args: any[]) => any>

const ITEM = 'item-1' as ItemId

describe('SnapshotCoverage', () => {
  let db: SyncLogDatabase
  let serverHeads: ServerHeads
  let firstStartState: FirstStartState | undefined
  let isSnapshotOnly: boolean
  let readDocHeads: AnyMock
  let requestUpload: AnyMock
  let coverage: SnapshotCoverage

  function createCoverage(): SnapshotCoverage {
    return new SnapshotCoverage({
      db,
      serverHeads,
      firstStartState: () => firstStartState,
      isSnapshotOnly: () => isSnapshotOnly,
      readDocHeads,
      requestUpload,
    })
  }

  beforeEach(() => {
    vi.stubGlobal('indexedDB', new IDBFactory())
    db = new SyncLogDatabase('account-1')
    serverHeads = new ServerHeads({ loadSyncedHeads: async () => [], saveSyncedHeads: async () => {} })
    firstStartState = undefined
    isSnapshotOnly = false
    readDocHeads = vi.fn().mockResolvedValue(['other-heads'])
    requestUpload = vi.fn()
    coverage = createCoverage()
  })

  afterEach(async () => {
    await serverHeads.shutdown({ clearLocalData: true })
    await db.close()
  })

  describe('S1, log before snapshot', () => {
    const base = () => Automerge.change(Automerge.init<{ title?: string }>(), d => { d.title = 'base' })

    it('covers a doc at its server heads', () => {
      const doc = base()
      serverHeads.set(ITEM, Automerge.getHeads(doc))

      expect(coverage.check(ITEM, doc)).toEqual({ covered: true })
    })

    it('defers a doc with changes after its server heads', () => {
      const doc = base()
      serverHeads.set(ITEM, Automerge.getHeads(doc))

      const edited = Automerge.change(doc, d => { d.title = 'edited' })

      expect(coverage.check(ITEM, edited)).toEqual({ covered: false, reason: 'unpushed' })
    })

    it('defers a doc with no known server heads, which is all unpushed', () => {
      expect(coverage.check(ITEM, base())).toEqual({ covered: false, reason: 'unpushed' })
    })

    it('defers an item waiting for its server heads', () => {
      firstStartState = 'awaitingHeads'

      expect(coverage.check(ITEM, base())).toEqual({ covered: false, reason: 'awaitingHeads' })
    })

    it('lets through an item at first start with no snapshot it can trust', () => {
      firstStartState = 'awaitingSnapshot'

      expect(coverage.check(ITEM, base())).toEqual({ covered: true })
    })

    it('lets through a change too large for a row', () => {
      isSnapshotOnly = true

      expect(coverage.check(ITEM, base())).toEqual({ covered: true })
    })
  })

  describe('S2, recheck after a version jump', () => {
    const stored = { itemId: ITEM, version: 5, baseVersion: 3, heads: ['uploaded'], logSeq: 10 }

    it('uploads again once the cursor reaches the seq, if the doc has moved on', async () => {
      await coverage.onSnapshotStored(stored)

      await coverage.onCursorAdvanced(9)
      expect(requestUpload).not.toHaveBeenCalled()

      await coverage.onCursorAdvanced(10)
      expect(requestUpload).toHaveBeenCalledWith(ITEM)

      requestUpload.mockClear()
      await coverage.onCursorAdvanced(11)
      expect(requestUpload).not.toHaveBeenCalled()
    })

    it('does nothing if the doc still matches the upload', async () => {
      readDocHeads.mockResolvedValue(['uploaded'])
      await coverage.onSnapshotStored(stored)

      await coverage.onCursorAdvanced(10)

      expect(requestUpload).not.toHaveBeenCalled()
    })

    it('ignores an upload that didn\'t jump', async () => {
      await coverage.onSnapshotStored({ ...stored, version: 4 })

      await coverage.onCursorAdvanced(10)

      expect(readDocHeads).not.toHaveBeenCalled()
    })

    it('ignores a tombstone, which has no heads', async () => {
      await coverage.onSnapshotStored({ ...stored, heads: undefined })

      await coverage.onCursorAdvanced(10)

      expect(readDocHeads).not.toHaveBeenCalled()
    })

    it('keeps the record when the doc can\'t be read yet', async () => {
      readDocHeads.mockResolvedValueOnce(null)
      await coverage.onSnapshotStored(stored)

      await coverage.onCursorAdvanced(10)
      await coverage.onCursorAdvanced(10)

      expect(requestUpload).toHaveBeenCalledTimes(1)
    })

    it('survives a reload', async () => {
      await coverage.onSnapshotStored(stored)

      const reloaded = createCoverage()
      await reloaded.load()
      await reloaded.onCursorAdvanced(10)

      expect(requestUpload).toHaveBeenCalledWith(ITEM)
    })
  })

  describe('S3 records', () => {
    it('keeps when an item first gained pulled changes', async () => {
      vi.spyOn(Date, 'now').mockReturnValueOnce(100).mockReturnValueOnce(200)

      await coverage.recordPulledChanges([ITEM])
      await coverage.recordPulledChanges([ITEM])

      expect(await coverage.listUnconfirmedPulls()).toEqual(new Map([[ITEM, 100]]))
    })

    it('forgets items a snapshot has confirmed', async () => {
      await coverage.recordPulledChanges([ITEM])

      await coverage.confirmPulledChanges([ITEM])

      expect((await coverage.listUnconfirmedPulls()).size).toBe(0)
    })
  })
})

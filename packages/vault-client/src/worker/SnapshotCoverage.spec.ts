import * as Automerge from '@automerge/automerge/slim'
import { IDBFactory } from 'fake-indexeddb'
import type { ItemId } from '@vault/shared'
import { ServerHeads } from './ServerHeads'
import { SnapshotCoverage } from './SnapshotCoverage'
import type { FirstStartState } from './FirstStart'
import { SyncLogDatabase } from './stores/SyncLogDatabase'

const ITEM = 'item-1' as ItemId

describe('SnapshotCoverage', () => {
  let db: SyncLogDatabase
  let serverHeads: ServerHeads
  let firstStartState: FirstStartState | undefined
  let isSnapshotOnly: boolean
  let coverage: SnapshotCoverage

  function createCoverage(): SnapshotCoverage {
    return new SnapshotCoverage({
      db,
      serverHeads,
      firstStartState: () => firstStartState,
      isSnapshotOnly: () => isSnapshotOnly,
    })
  }

  beforeEach(() => {
    vi.stubGlobal('indexedDB', new IDBFactory())
    db = new SyncLogDatabase('account-1')
    serverHeads = new ServerHeads(db)
    firstStartState = undefined
    isSnapshotOnly = false
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

  describe('S2 records', () => {
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

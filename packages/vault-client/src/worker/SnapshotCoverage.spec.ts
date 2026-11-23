import * as Automerge from '@automerge/automerge/slim'
import type { ItemId } from '@vault/shared'
import { ItemSyncState } from './ItemSyncState'
import { SnapshotCoverage } from './SnapshotCoverage'
import { SyncSessionState } from './SyncSessionState'
import { createMemoryItemRecords } from './__test__/testUtils'

const ITEM = 'item-1' as ItemId

describe('SnapshotCoverage', () => {
  let itemSyncState: ItemSyncState
  let coverage: SnapshotCoverage

  beforeEach(() => {
    itemSyncState = new ItemSyncState({ db: createMemoryItemRecords().db, session: new SyncSessionState() })
    coverage = new SnapshotCoverage({ itemSyncState })
  })

  afterEach(async () => {
    await itemSyncState.shutdown({ clearLocalData: true })
  })

  describe('S1, log before snapshot', () => {
    const base = () => Automerge.change(Automerge.init<{ title?: string }>(), d => { d.title = 'base' })

    it('covers a doc at its server heads', () => {
      const doc = base()
      itemSyncState.setServerHeads(ITEM, Automerge.getHeads(doc))

      expect(coverage.check(ITEM, doc)).toEqual({ covered: true })
    })

    it('defers a doc with changes after its server heads', () => {
      const doc = base()
      itemSyncState.setServerHeads(ITEM, Automerge.getHeads(doc))

      const edited = Automerge.change(doc, d => { d.title = 'edited' })

      expect(coverage.check(ITEM, edited)).toEqual({ covered: false, reason: 'unpushed' })
    })

    it('defers a doc with no known server heads, which is all unpushed', () => {
      expect(coverage.check(ITEM, base())).toEqual({ covered: false, reason: 'unpushed' })
    })

    it('lets through a change too large for a row', () => {
      itemSyncState.setSnapshotOnly(ITEM)

      expect(coverage.check(ITEM, base())).toEqual({ covered: true })
    })
  })
})

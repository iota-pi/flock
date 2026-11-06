import { Repo } from '@automerge/automerge-repo/slim'
import * as Automerge from '@automerge/automerge/slim'
import type { AutomergeDocStore } from './AutomergeDocStore'
import type { ItemId } from '@vault/shared'
import type { VaultDoc } from '../../shared/types'
import { createTestDocStore } from '../__test__/testUtils'
import { toDocumentIdFromItemId } from '../utils/automerge'

type NotesDoc = VaultDoc & { notes: Array<{ id: string; text: string; archived: boolean; time: number }> }

/** Everything `doc` has after `base`, as a log row holds it */
function changesSince(doc: Automerge.Doc<NotesDoc>, base: Automerge.Doc<NotesDoc>): Uint8Array {
  const changes = Automerge.getChangesSince(doc, Automerge.getHeads(base))
  const row = new Uint8Array(changes.reduce((total, change) => total + change.byteLength, 0))
  let offset = 0
  for (const change of changes) {
    row.set(change, offset)
    offset += change.byteLength
  }
  return row
}

function createBaseDocBinary(id: ItemId, name = 'Base Name', description = 'Base Desc'): Uint8Array {
  const doc = Automerge.change(Automerge.init<NotesDoc>(), d => {
    d.id = id
    d.type = 'person'
    d.name = name
    d.description = description
    d.created = 1000
    d.archived = false
    d.prayerFrequency = 'none'
    d.notes = [{ id: 'note-base', text: 'Base Note', archived: false, time: 1000 }]
    d.prayedFor = []
  })
  return Automerge.save(doc)
}

function forkDocBinary(baseBinary: Uint8Array, changeFn: (d: NotesDoc) => void): Uint8Array {
  const doc = Automerge.load<NotesDoc>(baseBinary)
  const updated = Automerge.change(doc, changeFn)
  return Automerge.save(updated)
}

describe('Document Hydration Race Condition (C4)', () => {
  let repo: Repo
  let docStore: AutomergeDocStore

  beforeEach(() => {
    repo = new Repo()
    docStore = createTestDocStore(repo)
  })

  it('serializes concurrent hydrateAutomergeDocumentBinary calls on the same item without clobbering', async () => {
    const itemId = 'concurrent-item-1' as ItemId
    const baseBinary = createBaseDocBinary(itemId)

    const binary1 = forkDocBinary(baseBinary, d => {
      d.name = 'First Hydration Name'
      d.notes.push({ id: 'note-1', text: 'Note 1', archived: false, time: 2000 })
    })
    const binary2 = forkDocBinary(baseBinary, d => {
      d.description = 'Second Hydration Desc'
      d.notes.push({ id: 'note-2', text: 'Note 2', archived: false, time: 3000 })
    })

    // Run both hydrations concurrently
    const [res1, res2] = await Promise.all([
      docStore.hydrateAutomergeDocumentBinary(itemId, binary1),
      docStore.hydrateAutomergeDocumentBinary(itemId, binary2),
    ])

    expect(res1).toBeDefined()
    expect(res2).toBeDefined()

    const item = await docStore.getAutomergeItem(itemId) as NotesDoc | null
    expect(item).not.toBeNull()
    // The second hydration should have merged into the first cleanly
    expect(item?.name).toBe('First Hydration Name')
    expect(item?.description).toBe('Second Hydration Desc')
    const noteTexts = item?.notes?.map(n => n.text)
    expect(noteTexts).toContain('Base Note')
    expect(noteTexts).toContain('Note 1')
    expect(noteTexts).toContain('Note 2')
  })

  it('keeps a log row from interleaving with async storage I/O during hydration', async () => {
    const itemId = 'race-item-1' as ItemId
    const baseBinary = createBaseDocBinary(itemId)

    const baseDoc = Automerge.load<NotesDoc>(baseBinary)
    const updatedDoc = Automerge.change(Automerge.clone(baseDoc), d => {
      d.description = 'Incremental Edit from Device A'
      d.notes.push({ id: 'note-inc', text: 'Incremental Note', archived: false, time: 2000 })
    })

    // Hook loadDocDataFromStorage on docStore to simulate async disk I/O delay
    const storageDelay = Promise.withResolvers<void>()
    const originalLoadDocData = docStore.loadDocDataFromStorage.bind(docStore)
    vi.spyOn(docStore, 'loadDocDataFromStorage').mockImplementation(async (id: ItemId) => {
      if (id === itemId) {
        await storageDelay.promise
      }
      return originalLoadDocData(id)
    })

    // 1. Start hydration, which holds the item lock while storage is reading
    const hydrationPromise = docStore.hydrateAutomergeDocumentBinary(itemId, baseBinary)

    // 2. Concurrently, a log row arrives for the item
    const onApplied = vi.fn()
    const applyPromise = docStore.applyIncomingChanges(itemId, changesSince(updatedDoc, baseDoc), onApplied)

    await new Promise(r => setTimeout(r, 20))
    expect(onApplied).not.toHaveBeenCalled()

    // 3. Hydration finishes and seeds the doc, and then the row can take the lock
    storageDelay.resolve()
    await hydrationPromise
    expect(await applyPromise).toEqual({ status: 'applied', addedChanges: true })

    // 4. The document has both the baseline and the incremental changes
    const item = await docStore.getAutomergeItem(itemId) as NotesDoc | null
    expect(item).not.toBeNull()
    expect(item?.name).toBe('Base Name')
    expect(item?.description).toBe('Incremental Edit from Device A')
    const noteTexts = item?.notes?.map(n => n.text)
    expect(noteTexts).toContain('Base Note')
    expect(noteTexts).toContain('Incremental Note')
  })

  it('merges a snapshot over a doc a log row has already changed', async () => {
    const itemId = 'race-item-2' as ItemId
    const baseBinary = createBaseDocBinary(itemId)
    const baseDoc = Automerge.load<NotesDoc>(baseBinary)

    const docA = Automerge.change(Automerge.clone(baseDoc), d => {
      d.name = 'Device A Name'
      d.notes.push({ id: 'note-a', text: 'Device A Note', archived: false, time: 2000 })
    })
    const docB = Automerge.change(Automerge.load<NotesDoc>(baseBinary), d => {
      d.description = 'Device B Desc'
      d.notes.push({ id: 'note-b', text: 'Device B Note', archived: false, time: 3000 })
    })

    repo.import<any>(baseBinary, { docId: toDocumentIdFromItemId(itemId) })
    await docStore.applyIncomingChanges(itemId, changesSince(docA, baseDoc))
    const result = await docStore.hydrateAutomergeDocumentBinary(itemId, Automerge.save(docB))

    expect(result.hasLocalChanges).toBe(true)
    const item = await docStore.getAutomergeItem(itemId) as NotesDoc | null
    expect(item?.name).toBe('Device A Name')
    expect(item?.description).toBe('Device B Desc')
    const noteTexts = item?.notes?.map(n => n.text)
    expect(noteTexts).toContain('Device A Note')
    expect(noteTexts).toContain('Device B Note')
  })
})

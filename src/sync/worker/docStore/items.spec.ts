import { Repo } from '@automerge/automerge-repo/slim'
import * as Automerge from '@automerge/automerge/slim'
import { AutomergeDocStore, normalizeItemSnapshot } from './AutomergeDocStore'
import type { Item } from 'src/state/items'
import { ItemId } from 'src/shared/schemas/items'

const testRepo = new Repo()

describe('items operations', () => {
  let docStore: AutomergeDocStore

  beforeEach(async () => {
    docStore = new AutomergeDocStore(testRepo)
  })

  it('should create and retrieve an item successfully', async () => {
    const item: Item = {
      id: 'test-item-id' as ItemId,
      type: 'person',
      name: 'Test Prayer',
      description: 'A test prayer item',
      created: Date.now(),
      archived: false,
      prayerFrequency: 'none',
      notes: [],
      prayedFor: [],
    }

    const created = await docStore.changeDocument(
      item.id,
      (doc: any) => {
        for (const [key, value] of Object.entries(item)) {
          doc[key] = value
        }
      },
      { createIfMissing: true }
    )

    expect(created).toBe(true)

    const retrieved = await docStore.getAutomergeItem(item.id)
    expect(retrieved).toEqual(item)
  })

  it('should remove an item successfully', async () => {
    const item: Item = {
      id: 'test-item-remove' as ItemId,
      type: 'person',
      name: 'Test Prayer Remove',
      description: 'A test prayer item to remove',
      created: Date.now(),
      archived: false,
      prayerFrequency: 'none',
      notes: [],
      prayedFor: [],
    }

    await docStore.changeDocument(
      item.id,
      (doc: any) => {
        for (const [key, value] of Object.entries(item)) {
          doc[key] = value
        }
      },
      { createIfMissing: true }
    )

    await docStore.removeAutomergeItem(item.id)

    const retrieved = await docStore.getAutomergeItem(item.id)
    expect(retrieved).toBeNull()
  })

  it('should self-heal a snapshot with topic type containing leftover group fields', () => {
    const rawSnapshot = {
      id: 'converted-topic-1',
      type: 'topic',
      name: 'Global Topic',
      description: 'Formerly a group',
      created: 10000,
      archived: false,
      prayerFrequency: 'none',
      notes: [],
      prayedFor: [],
      members: ['member-1'],
      memberPrayerFrequency: 'daily',
      memberPrayerTarget: 'all',
    }

    const normalized = normalizeItemSnapshot('converted-topic-1' as ItemId, rawSnapshot)
    expect(normalized).not.toBeNull()
    expect(normalized?.type).toBe('topic')
    expect(normalized?.name).toBe('Global Topic')
    expect((normalized as any).members).toBeUndefined()
    expect((normalized as any).memberPrayerFrequency).toBeUndefined()
    expect((normalized as any).memberPrayerTarget).toBeUndefined()
  })

  it('should not delete existing storage document or overwrite with blank doc when load times out', async () => {
    const customRepo = new Repo()
    const deleteSpy = vi.spyOn(customRepo, 'delete')
    const importSpy = vi.spyOn(customRepo, 'import')

    // Mock storageSubsystem to indicate doc exists in storage
    const mockStorage = {
      loadDocData: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
    }
    // @ts-expect-error Mocking internal storageSubsystem
    customRepo.storageSubsystem = mockStorage

    // Mock repo.find to time out / fail
    vi.spyOn(customRepo, 'find').mockRejectedValue(new Error('Timed out'))

    const customDocStore = new AutomergeDocStore(customRepo)

    const result = await customDocStore.changeDocument(
      'existing-item' as ItemId,
      draft => {
        draft.name = 'New Name'
      },
      { createIfMissing: true }
    )

    // Should return false rather than deleting or overwriting
    expect(result).toBe(false)
    expect(deleteSpy).not.toHaveBeenCalled()
    expect(importSpy).not.toHaveBeenCalled()
  })

  it('should create document if it genuinely does not exist in storage', async () => {
    const customRepo = new Repo()
    const importSpy = vi.spyOn(customRepo, 'import')

    // Mock storageSubsystem to indicate doc does NOT exist
    const mockStorage = {
      loadDocData: vi.fn().mockResolvedValue(undefined),
    }
    // @ts-expect-error Mocking internal storageSubsystem
    customRepo.storageSubsystem = mockStorage

    const customDocStore = new AutomergeDocStore(customRepo)

    const result = await customDocStore.changeDocument(
      'new-item' as ItemId,
      draft => {
        draft.id = 'new-item'
        draft.type = 'person'
        draft.name = 'New Person'
      },
      { createIfMissing: true }
    )

    expect(result).toBe(true)
    expect(importSpy).toHaveBeenCalled()
  })

  it('should handle concurrent findOrCreateHandle calls without duplicate creation or orphaned handles', async () => {
    const customRepo = new Repo()
    const deleteSpy = vi.spyOn(customRepo, 'delete')
    const importSpy = vi.spyOn(customRepo, 'import')

    const mockStorage = {
      loadDocData: vi.fn().mockImplementation(async () => {
        // Yield to allow concurrent calls to interleave
        await new Promise(resolve => setTimeout(resolve, 10))
        return undefined
      }),
    }
    // @ts-expect-error Mocking internal storageSubsystem
    customRepo.storageSubsystem = mockStorage

    const customDocStore = new AutomergeDocStore(customRepo)

    const [handleA, handleB] = await Promise.all([
      customDocStore.findOrCreateHandle('concurrent-item' as ItemId),
      customDocStore.findOrCreateHandle('concurrent-item' as ItemId),
    ])

    expect(handleA).toBeDefined()
    expect(handleB).toBeDefined()
    expect(handleA).toBe(handleB)
    expect(importSpy).toHaveBeenCalledTimes(1)
    expect(deleteSpy).toHaveBeenCalledTimes(1)
  })

  it('should cleanly import snapshot when document does not exist locally', async () => {
    const remoteDoc = Automerge.change(Automerge.init<Item>(), doc => {
      doc.id = 'imported-item-1' as ItemId
      doc.type = 'person'
      doc.name = 'Remote Prayer'
      doc.description = 'Remote Description'
      doc.created = 1000
      doc.archived = false
      doc.prayerFrequency = 'none'
      doc.notes = []
      doc.prayedFor = []
    })
    const remoteBinary = Automerge.save(remoteDoc)

    await docStore.hydrateAutomergeDocumentBinary('imported-item-1', remoteBinary)

    const retrieved = await docStore.getAutomergeItem('imported-item-1' as ItemId)
    expect(retrieved).not.toBeNull()
    expect(retrieved?.name).toBe('Remote Prayer')
    expect(retrieved?.description).toBe('Remote Description')
  })

  it('should MERGE local CRDT history with incoming snapshot when document already exists locally', async () => {
    const baseNote = { id: 'note-base', text: 'Base Note', archived: false, time: 1000 }
    const localNote = { id: 'note-local', text: 'Local Note', archived: false, time: 2000 }
    const remoteNote = { id: 'note-remote', text: 'Remote Note', archived: false, time: 3000 }

    // 1. Initial base document
    const baseDoc = Automerge.change(Automerge.init<Item>(), doc => {
      doc.id = 'merged-item-1' as ItemId
      doc.type = 'person'
      doc.name = 'Base Name'
      doc.description = 'Base Description'
      doc.created = 1000
      doc.archived = false
      doc.prayerFrequency = 'none'
      doc.notes = [baseNote]
      doc.prayedFor = []
    })
    const baseBinary = Automerge.save(baseDoc)

    // Load base doc into local docStore
    await docStore.hydrateAutomergeDocumentBinary('merged-item-1', baseBinary)

    // 2. Make concurrent local edits in docStore
    await docStore.changeDocument('merged-item-1' as ItemId, (doc: any) => {
      doc.name = 'Locally Updated Name'
      doc.notes.push(localNote)
    })

    // 3. Simultaneously, remote branch makes different edits from baseDoc
    const remoteBranch = Automerge.load<Item>(baseBinary)
    const remoteUpdatedDoc = Automerge.change(remoteBranch, doc => {
      doc.description = 'Remotely Updated Description'
      doc.notes.push(remoteNote)
    })
    const remoteSnapshotBinary = Automerge.save(remoteUpdatedDoc)

    // 4. Hydrate the incoming snapshot into docStore
    await docStore.hydrateAutomergeDocumentBinary('merged-item-1', remoteSnapshotBinary)

    // 5. Verify that local and remote changes are both merged seamlessly
    const mergedResult = await docStore.getAutomergeItem('merged-item-1' as ItemId)
    expect(mergedResult).not.toBeNull()
    // Local edit preserved
    expect(mergedResult?.name).toBe('Locally Updated Name')
    // Remote edit merged in
    expect(mergedResult?.description).toBe('Remotely Updated Description')
    // Both notes present in merged CRDT state
    const noteTexts = mergedResult?.notes?.map(n => n.text)
    expect(noteTexts).toContain('Local Note')
    expect(noteTexts).toContain('Remote Note')
  })
})


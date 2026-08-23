import { Repo } from '@automerge/automerge-repo/slim'
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
})


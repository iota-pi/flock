import { getBlankGroup, getBlankItem, getBlankPerson, type Item } from '../state/items'
import { convertItemType, createItem, deleteItems, mutateItem, setMetadata, storeItems } from '../features/items/mutations/itemMutations'
import { SyncBridge } from '../sync/client/SyncBridge'
import { setApiAuthToken } from './runtime'
import { useAppStore } from '../state/store'
import type { AccountMetadata } from '../state/metadata'
import { ItemId } from 'src/shared/schemas/items'

const metadataState: Partial<AccountMetadata> = {}

const mocks = vi.hoisted(() => ({
  pruneItemDrawers: vi.fn(),
}))

vi.mock('../sync/client/SyncBridge', () => ({
  SyncBridge: {
    mutateItem: vi.fn(async () => {}),
    storeItems: vi.fn(async () => {}),
    createItem: vi.fn(async () => {}),
    mutateMetadata: vi.fn(async () => {}),
    clearAutomergeDocStore: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
  }
}))

vi.mock('./util', () => ({
  getAccountId: vi.fn(() => 'test-account'),
}))


const mockStoreState = vi.hoisted(() => {
  const state = {
    pruneItemDrawers: mocks.pruneItemDrawers,
    closeIfOpen: vi.fn(),
    optimisticUpdateItem: vi.fn((id: string, partial: Partial<Item>) => {
      state.items[id] = { ...state.items[id], ...partial } as Item
    }),
    updateItemsFromServer: vi.fn((updates: { id: string; item: Item | null }[]) => {
      for (const update of updates) {
        if (update.item) {
          state.items[update.id] = update.item
        } else {
          delete state.items[update.id]
        }
      }
    }),
    updateMetadata: vi.fn((metadata: Partial<AccountMetadata>) => {
      state.metadata = { ...state.metadata, ...metadata } as AccountMetadata
    }),
    items: {} as Record<string, Item>,
    metadata: {} as AccountMetadata,
  }
  return state
})

vi.mock('../state/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: typeof mockStoreState) => unknown) => selector(mockStoreState),
    {
      getState: () => mockStoreState,
      setState: vi.fn((update: Partial<typeof mockStoreState>) => {
        Object.assign(mockStoreState, update)
      }),
    }
  )
}))

describe('local-first mutations', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    for (const key of Object.keys(metadataState) as (keyof AccountMetadata)[]) {
      delete metadataState[key]
    }

    vi.mocked(SyncBridge.mutateMetadata).mockImplementation(async (changes: Partial<AccountMetadata>) => {
      Object.assign(metadataState, changes)
    })

    setApiAuthToken('')
    useAppStore.setState({ items: {}, metadata: metadataState as AccountMetadata })
  })

  it('stores single-item snapshots', async () => {
    const item = getBlankPerson('p1' as ItemId)

    const result = await storeItems(item)

    expect(result[0].id).toBe('p1')
    expect(SyncBridge.storeItems).toHaveBeenCalledWith([expect.objectContaining({ id: 'p1' })])
  })

  it('rejects invalid item payloads before storing', async () => {
    await expect(storeItems({ id: '', type: 'person' } as unknown as Item)).rejects.toBeTruthy()
    expect(SyncBridge.storeItems).not.toHaveBeenCalled()
  })

  it('stores batch updates for all ids', async () => {
    const first = getBlankPerson('p1' as ItemId)
    const second = getBlankPerson('p2' as ItemId)

    await storeItems([first, second])

    expect(SyncBridge.storeItems).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'p1' }),
      expect.objectContaining({ id: 'p2' }),
    ])
  })

  it('deletes with group updates and tombstones', async () => {
    const group = {
      ...getBlankGroup('g1' as ItemId, false),
      members: ['p1' as ItemId],
    }
    const person = getBlankPerson('p1' as ItemId, false)
    useAppStore.setState({ items: { g1: group, p1: person } })

    await deleteItems('p1' as ItemId)
    expect(SyncBridge.storeItems).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ id: 'g1', members: [] }),
      expect.objectContaining({ id: 'p1', deleted: true }),
    ]))
  })

  it('converts person to group and removes the item from all groups it is a member of', async () => {
    const group1 = {
      ...getBlankGroup('g1' as ItemId, false),
      members: ['p1' as ItemId, 'p2' as ItemId],
    }
    const group2 = {
      ...getBlankGroup('g2' as ItemId, false),
      members: ['p1' as ItemId],
    }
    const unrelatedGroup = {
      ...getBlankGroup('g3' as ItemId, false),
      members: ['p2' as ItemId],
    }
    const person1 = getBlankPerson('p1' as ItemId, false)
    person1.name = 'Alice'

    useAppStore.setState({
      items: {
        g1: group1,
        g2: group2,
        g3: unrelatedGroup,
        p1: person1,
      },
    })

    const converted = await convertItemType('p1' as ItemId, 'group')

    expect(converted.type).toBe('group')
    expect(converted.id).toBe('p1')
    expect(SyncBridge.storeItems).toHaveBeenCalledWith([
      expect.objectContaining({
        id: 'p1',
        type: 'group',
        members: [],
      }),
      expect.objectContaining({
        id: 'g1',
        members: ['p2'],
      }),
      expect.objectContaining({
        id: 'g2',
        members: [],
      }),
    ])
  })

  it('converts topic to group and removes the item from all groups it is a member of', async () => {
    const group1 = {
      ...getBlankGroup('g1' as ItemId, false),
      members: ['t1' as ItemId],
    }
    const topic = {
      ...getBlankItem('topic', false),
      id: 't1' as ItemId,
      name: 'World Peace',
    }

    useAppStore.setState({
      items: {
        g1: group1,
        t1: topic,
      },
    })

    const converted = await convertItemType('t1' as ItemId, 'group')

    expect(converted.type).toBe('group')
    expect(SyncBridge.storeItems).toHaveBeenCalledWith([
      expect.objectContaining({
        id: 't1',
        type: 'group',
        members: [],
      }),
      expect.objectContaining({
        id: 'g1',
        members: [],
      }),
    ])
  })

  it('converts group to person and clears group properties without modifying other groups', async () => {
    const group1 = {
      ...getBlankGroup('g1' as ItemId, false),
      name: 'Bible Study',
      members: ['p1' as ItemId],
    }

    useAppStore.setState({
      items: {
        g1: group1,
      },
    })

    const converted = await convertItemType('g1' as ItemId, 'person')

    expect(converted.type).toBe('person')
    expect((converted as any).members).toBeUndefined()
    expect(SyncBridge.storeItems).toHaveBeenCalledWith([
      expect.objectContaining({
        id: 'g1',
        type: 'person',
      }),
    ])
  })

  it('returns same item when converting to current type', async () => {
    const person = getBlankPerson('p1' as ItemId, false)
    useAppStore.setState({ items: { p1: person } })

    const result = await convertItemType('p1' as ItemId, 'person')
    expect(result).toBe(person)
    expect(SyncBridge.storeItems).not.toHaveBeenCalled()
  })

  it('throws when item is not found during convertItemType', async () => {
    useAppStore.setState({ items: {} })
    await expect(convertItemType('nonexistent' as ItemId, 'group')).rejects.toThrow('Item not found: nonexistent')
  })

  it('updates metadata locally', async () => {
    const result = await setMetadata({ prayerGoal: 20 })

    expect(result.prayerGoal).toBe(20)
    expect(SyncBridge.mutateMetadata).toHaveBeenCalledTimes(1)
  })

  it('serializes functional metadata updates to avoid stale overwrites', async () => {
    await Promise.all([
      setMetadata(previous => ({
        ...previous,
        prayerGoal: 25,
      })),
      setMetadata(previous => ({
        ...previous,
        sortCriteria: [{ type: 'name', reverse: false }],
      })),
    ])

    expect(metadataState.prayerGoal).toBe(25)
    expect(metadataState.sortCriteria).toEqual([{ type: 'name', reverse: false }])
  })

  describe('optimistic update rollbacks on worker failure', () => {
    it('rolls back mutateItem on SyncBridge failure', async () => {
      const originalPerson = getBlankPerson('p1' as ItemId, false)
      originalPerson.name = 'Original Name'
      useAppStore.setState({
        items: {
          p1: originalPerson,
        },
      })

      vi.mocked(SyncBridge.mutateItem).mockRejectedValueOnce(new Error('Worker crashed'))

      await mutateItem('p1' as ItemId, { name: 'Optimistic Name' })

      // Wait for promise microtask queue to flush the catch block
      await new Promise(resolve => setTimeout(resolve, 0))

      expect(mockStoreState.updateItemsFromServer).toHaveBeenCalledWith([
        {
          id: 'p1',
          item: expect.objectContaining({
            id: 'p1',
            name: 'Original Name',
          }),
        },
      ])
    })

    it('preserves concurrent edits on other fields during mutateItem rollback', async () => {
      const originalPerson = getBlankPerson('p1' as ItemId, false)
      originalPerson.name = 'Original Name'
      originalPerson.summary = 'Original Summary'
      useAppStore.setState({
        items: {
          p1: originalPerson,
        },
      })

      let rejectMutate: (err: unknown) => void = () => {}
      const mutatePromise = new Promise<void>((_, reject) => {
        rejectMutate = reject
      })
      vi.mocked(SyncBridge.mutateItem).mockReturnValueOnce(mutatePromise)

      await mutateItem('p1' as ItemId, { name: 'New Name' })

      // Simulate a concurrent edit to summary happening in between
      useAppStore.setState({
        items: {
          p1: {
            ...originalPerson,
            name: 'New Name',
            summary: 'Concurrent Summary Update',
          },
        },
      })

      rejectMutate(new Error('Worker timeout'))
      await new Promise(resolve => setTimeout(resolve, 0))

      expect(mockStoreState.updateItemsFromServer).toHaveBeenCalledWith([
        {
          id: 'p1',
          item: expect.objectContaining({
            id: 'p1',
            name: 'Original Name',
            summary: 'Concurrent Summary Update',
          }),
        },
      ])
    })

    it('rolls back createItem on SyncBridge failure', async () => {
      vi.mocked(SyncBridge.createItem).mockRejectedValueOnce(new Error('Worker error'))

      const created = await createItem('person')

      await new Promise(resolve => setTimeout(resolve, 0))

      expect(mockStoreState.updateItemsFromServer).toHaveBeenCalledWith([
        {
          id: created.id,
          item: null,
        },
      ])
    })

    it('rolls back storeItems on SyncBridge failure', async () => {
      const originalPerson = getBlankPerson('p1' as ItemId, false)
      originalPerson.name = 'Old Name'
      useAppStore.setState({
        items: {
          p1: originalPerson,
        },
      })

      vi.mocked(SyncBridge.storeItems).mockRejectedValueOnce(new Error('Automerge error'))

      const updated = { ...originalPerson, name: 'New Name' }
      await expect(storeItems(updated)).rejects.toThrow('Automerge error')

      expect(mockStoreState.updateItemsFromServer).toHaveBeenCalledWith([
        {
          id: 'p1',
          item: expect.objectContaining({
            id: 'p1',
            name: 'Old Name',
          }),
        },
      ])
    })

    it('rolls back convertItemType and group updates on SyncBridge failure', async () => {
      const originalPerson = getBlankPerson('p1' as ItemId, false)
      originalPerson.name = 'Alice'
      const originalGroup = {
        ...getBlankGroup('g1' as ItemId, false),
        members: ['p1' as ItemId],
      }
      useAppStore.setState({
        items: {
          p1: originalPerson,
          g1: originalGroup,
        },
      })

      vi.mocked(SyncBridge.storeItems).mockRejectedValueOnce(new Error('Sync failure'))

      await expect(convertItemType('p1' as ItemId, 'group')).rejects.toThrow('Sync failure')

      expect(mockStoreState.updateItemsFromServer).toHaveBeenCalledWith([
        {
          id: 'p1',
          item: expect.objectContaining({
            id: 'p1',
            type: 'person',
            name: 'Alice',
          }),
        },
      ])
      expect(mockStoreState.updateItemsFromServer).toHaveBeenCalledWith([
        {
          id: 'g1',
          item: expect.objectContaining({
            id: 'g1',
            members: ['p1'],
          }),
        },
      ])
    })

    it('rolls back setMetadata on SyncBridge failure', async () => {
      useAppStore.setState({
        metadata: {
          prayerGoal: 10,
        },
      })

      vi.mocked(SyncBridge.mutateMetadata).mockRejectedValueOnce(new Error('Sync error'))

      await expect(setMetadata({ prayerGoal: 50 })).rejects.toThrow('Sync error')

      expect(mockStoreState.updateMetadata).toHaveBeenCalledWith({
        prayerGoal: 10,
      })
    })
  })
})


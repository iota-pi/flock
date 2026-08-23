import { getBlankGroup, getBlankPerson, type Item } from '../state/items'
import { deleteItems, setMetadata, storeItems } from '../features/items/mutations/itemMutations'
import { SyncBridge } from '../sync/client/SyncBridge'
import { setApiAuthToken } from './runtime'
import { useAppStore } from '../state/store'
import { ItemId } from 'src/shared/schemas/items'

const metadataState: Record<string, unknown> = {}

const mocks = vi.hoisted(() => ({
  pruneItemDrawers: vi.fn(),
}))

vi.mock('../sync/client/SyncBridge', () => ({
  SyncBridge: {
    storeItems: vi.fn(async () => true),
    createItem: vi.fn(async () => true),
    mutateMetadata: vi.fn(async () => true),
    clearAutomergeDocStore: vi.fn(async () => true),
    shutdown: vi.fn(async () => {}),
  }
}))

vi.mock('./util', () => ({
  getAccountId: vi.fn(() => 'test-account'),
}))


const mockStoreState = vi.hoisted(() => ({
  pruneItemDrawers: mocks.pruneItemDrawers,
  closeIfOpen: vi.fn(),
  optimisticUpdateItem: vi.fn(),
  updateItemsFromServer: vi.fn(),
  updateMetadataFromServer: vi.fn(),
  items: {} as any,
  metadata: {} as any,
}))

vi.mock('../state/store', () => ({
  useAppStore: Object.assign(
    (selector: any) => selector(mockStoreState),
    {
      getState: () => mockStoreState,
      setState: vi.fn((update: any) => {
        Object.assign(mockStoreState, update)
      }),
    }
  )
}))

describe('local-first mutations', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    for (const key of Object.keys(metadataState)) {
      delete metadataState[key]
    }

    vi.mocked(SyncBridge.mutateMetadata).mockImplementation(async (changes: any) => {
      Object.assign(metadataState, changes)
      return true as any
    })

    setApiAuthToken('')
    useAppStore.setState({ items: {}, metadata: metadataState })
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
      members: ['p1'],
    }
    const person = getBlankPerson('p1' as ItemId, false)
    useAppStore.setState({ items: { g1: group, p1: person } as any })

    await deleteItems('p1' as ItemId)
    expect(SyncBridge.storeItems).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ id: 'g1', members: [] }),
      expect.objectContaining({ id: 'p1', deleted: true }),
    ]))
  })

  it('updates metadata locally', async () => {
    const result = await setMetadata({ prayerGoal: 20 } as any)

    expect(result.prayerGoal).toBe(20)
    expect(SyncBridge.mutateMetadata).toHaveBeenCalledTimes(1)
  })

  it('serializes functional metadata updates to avoid stale overwrites', async () => {
    await Promise.all([
      setMetadata(previous => ({
        ...previous,
        prayerGoal: 25,
      } as any)),
      setMetadata(previous => ({
        ...previous,
        sortCriteria: [{ type: 'name', reverse: false }],
      } as any)),
    ])

    expect(metadataState.prayerGoal).toBe(25)
    expect(metadataState.sortCriteria).toEqual([{ type: 'name', reverse: false }])
  })
})


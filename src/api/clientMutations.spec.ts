import { getBlankGroup, getBlankPerson, type Item } from '../state/items'
import { deleteItems, setMetadata, storeItems } from '../features/items/mutations/itemMutations'
import { SyncBridge } from '../sync/SyncBridge'
import { setApiAuthToken } from './runtime'
import { useDataStore } from '../state/dataStore'

const metadataState: Record<string, unknown> = {}

const mocks = vi.hoisted(() => ({
  pruneItemDrawers: vi.fn(),
}))

vi.mock('../sync/SyncBridge', () => ({
  SyncBridge: {
    storeItems: vi.fn(async () => true),
    createItem: vi.fn(async () => true),
    hardDeleteItems: vi.fn(async () => true),
    mutateMetadata: vi.fn(async () => true),
    clearAutomergeDocStore: vi.fn(async () => true),
  }
}))

vi.mock('./util', () => ({
  getAccountId: vi.fn(() => 'test-account'),
}))


vi.mock('../state/navigationStore', () => ({
  useNavigationStore: {
    getState: () => ({
      pruneItemDrawers: mocks.pruneItemDrawers,
      closeIfOpen: vi.fn(),
    }),
  },
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
    useDataStore.setState({ items: {}, metadata: metadataState })
  })

  it('stores single-item snapshots', async () => {
    const item = getBlankPerson('p1')

    const result = await storeItems(item)

    expect(result[0].id).toBe('p1')
    expect(SyncBridge.storeItems).toHaveBeenCalledWith([expect.objectContaining({ id: 'p1' })])
  })

  it('rejects invalid item payloads before storing', async () => {
    await expect(storeItems({ id: '', type: 'person' } as unknown as Item)).rejects.toBeTruthy()
    expect(SyncBridge.storeItems).not.toHaveBeenCalled()
  })

  it('stores batch updates for all ids', async () => {
    const first = getBlankPerson('p1')
    const second = getBlankPerson('p2')

    await storeItems([first, second])

    expect(SyncBridge.storeItems).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'p1' }),
      expect.objectContaining({ id: 'p2' }),
    ])
  })

  it('deletes with group updates and tombstones', async () => {
    const group = {
      ...getBlankGroup('g1', false),
      members: ['p1'],
    }
    const person = getBlankPerson('p1', false)
    useDataStore.setState({ items: { g1: group, p1: person } as any })

    await deleteItems('p1')
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


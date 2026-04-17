import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getBlankGroup, getBlankPerson, type Item } from '../state/items'
import { deleteItems, setMetadata, storeItems } from '../features/items/mutations/itemMutations'
import {
  getAutomergeItems,
  getAutomergeMetadata,
  initializeAutomergeDocStore,
  withAutomergeDocumentChange,
  withAutomergeMetadataChange,
} from '../sync/automergeDocStore'
import { requestAutomergeSync } from '../sync/automergeSyncDispatcher'
import { ensureItemsBootstrap } from './itemReadService'
import { setApiAuthToken } from './runtime'

const metadataState: Record<string, unknown> = {}

const mocks = vi.hoisted(() => ({
  pruneItemDrawers: vi.fn(),
}))

vi.mock('../sync/automergeDocStore', async importOriginal => {
  const actual = await importOriginal<typeof import('../sync/automergeDocStore')>()
  return {
    ...actual,
    getAutomergeItems: vi.fn(() => []),
    getAutomergeItem: vi.fn(() => null),
    getAutomergeMetadata: vi.fn(() => ({})),
    initializeAutomergeDocStore: vi.fn(),
    withAutomergeDocumentChange: vi.fn(async () => true),
    withAutomergeMetadataChange: vi.fn(async () => true),
  }
})

vi.mock('../sync/automergeSyncDispatcher', () => ({
  requestAutomergeSync: vi.fn(),
}))

vi.mock('../sync/automergeRepo', () => ({
  removeKnownAutomergeItemIds: vi.fn(),
}))

vi.mock('./util', () => ({
  getAccountId: vi.fn(() => 'test-account'),
}))

vi.mock('./itemReadService', async importOriginal => {
  const actual = await importOriginal<typeof import('./itemReadService')>()
  return {
    ...actual,
    ensureItemsBootstrap: vi.fn(),
  }
})

vi.mock('../state/navigationStore', () => ({
  useNavigationStore: {
    getState: () => ({
      pruneItemDrawers: mocks.pruneItemDrawers,
    }),
  },
}))

describe('local-first mutations', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    for (const key of Object.keys(metadataState)) {
      delete metadataState[key]
    }

    vi.mocked(getAutomergeMetadata).mockImplementation(() => ({
      ...metadataState,
    } as any))
    vi.mocked(withAutomergeMetadataChange).mockImplementation(async (change: (draft: Record<string, unknown>) => void) => {
      const draft = { ...metadataState }
      change(draft)
      for (const key of Object.keys(metadataState)) {
        delete metadataState[key]
      }
      Object.assign(metadataState, draft)
      return true
    })

    setApiAuthToken('')
    vi.mocked(ensureItemsBootstrap).mockResolvedValue()
    vi.mocked(getAutomergeItems).mockReturnValue([])
  })

  it('stores single-item snapshots and requests sync', async () => {
    const item = getBlankPerson('p1')

    const result = await storeItems(item)

    expect(result[0].id).toBe('p1')
    expect(initializeAutomergeDocStore).toHaveBeenCalledWith('test-account')
    expect(withAutomergeDocumentChange).toHaveBeenCalledWith(
      'p1',
      expect.any(Function),
      expect.objectContaining({
        createIfMissing: true,
      }),
    )
    expect(requestAutomergeSync).toHaveBeenCalledWith()
  })

  it('rejects invalid item payloads before storing', async () => {
    await expect(storeItems({ id: '', type: 'person' } as unknown as Item)).rejects.toBeTruthy()
    expect(withAutomergeDocumentChange).not.toHaveBeenCalled()
  })

  it('stores batch updates and requests sync for all ids', async () => {
    const first = getBlankPerson('p1')
    const second = getBlankPerson('p2')

    await storeItems([first, second])

    expect(withAutomergeDocumentChange).toHaveBeenCalledTimes(2)
    expect(withAutomergeDocumentChange).toHaveBeenCalledWith('p1', expect.any(Function), expect.any(Object))
    expect(withAutomergeDocumentChange).toHaveBeenCalledWith('p2', expect.any(Function), expect.any(Object))
    expect(requestAutomergeSync).toHaveBeenCalledWith()
  })

  it('deletes with group updates and tombstones', async () => {
    const group = {
      ...getBlankGroup('g1', false),
      members: ['p1'],
    }
    const person = getBlankPerson('p1', false)
    vi.mocked(getAutomergeItems).mockReturnValue([group, person])

    await deleteItems('p1')

    expect(ensureItemsBootstrap).not.toHaveBeenCalled()
    expect(withAutomergeDocumentChange).toHaveBeenCalledWith('g1', expect.any(Function), expect.any(Object))
    expect(withAutomergeDocumentChange).toHaveBeenCalledWith('p1', expect.any(Function), expect.any(Object))
    expect(requestAutomergeSync).toHaveBeenCalledWith()
    expect(mocks.pruneItemDrawers).toHaveBeenCalledWith(['p1'])
  })

  it('updates metadata locally', async () => {
    const result = await setMetadata({ prayerGoal: 20 } as any)

    expect(result.prayerGoal).toBe(20)
    expect(withAutomergeMetadataChange).toHaveBeenCalledTimes(1)
    expect(requestAutomergeSync).toHaveBeenCalledWith()
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

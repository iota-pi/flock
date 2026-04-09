import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getBlankGroup, getBlankPerson, type Item } from '../state/items'
import { deleteItems, setMetadata, storeItems } from '../features/items/mutations/itemMutations'
import {
  ACCOUNT_METADATA_DOCUMENT_ID,
  getAutomergeItems,
  initializeAutomergeDocStore,
  withAutomergeItemChange,
  withAutomergeMetadataChange,
} from '../sync/automergeDocStore'
import { requestAutomergeSync } from '../sync/automergeSyncDispatcher'
import { ensureItemsBootstrap } from './itemReadService'
import { setApiAuthToken } from './runtime'

const mocks = vi.hoisted(() => ({
  pruneItemDrawers: vi.fn(),
}))

vi.mock('../sync/automergeDocStore', async importOriginal => {
  const actual = await importOriginal<typeof import('../sync/automergeDocStore')>()
  return {
    ...actual,
    getAutomergeItems: vi.fn(() => []),
    initializeAutomergeDocStore: vi.fn(),
    withAutomergeItemChange: vi.fn(async () => undefined),
    withAutomergeMetadataChange: vi.fn(async () => undefined),
  }
})

vi.mock('../sync/automergeSyncDispatcher', () => ({
  requestAutomergeSync: vi.fn(),
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
    setApiAuthToken('')
    vi.mocked(ensureItemsBootstrap).mockResolvedValue()
    vi.mocked(getAutomergeItems).mockReturnValue([])
  })

  it('stores single-item snapshots and requests sync', async () => {
    const item = getBlankPerson('p1')

    const result = await storeItems(item)

    expect(result[0].id).toBe('p1')
    expect(initializeAutomergeDocStore).toHaveBeenCalledWith('test-account')
    expect(withAutomergeItemChange).toHaveBeenCalledWith('p1', expect.any(Function))
    expect(requestAutomergeSync).toHaveBeenCalledWith(['p1'])
  })

  it('rejects invalid item payloads before storing', async () => {
    await expect(storeItems({ id: '', type: 'person' } as unknown as Item)).rejects.toBeTruthy()
    expect(withAutomergeItemChange).not.toHaveBeenCalled()
  })

  it('stores batch updates and requests sync for all ids', async () => {
    const first = getBlankPerson('p1')
    const second = getBlankPerson('p2')

    await storeItems([first, second])

    expect(withAutomergeItemChange).toHaveBeenCalledTimes(2)
    expect(withAutomergeItemChange).toHaveBeenCalledWith('p1', expect.any(Function))
    expect(withAutomergeItemChange).toHaveBeenCalledWith('p2', expect.any(Function))
    expect(requestAutomergeSync).toHaveBeenCalledWith(['p1', 'p2'])
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
    expect(withAutomergeItemChange).toHaveBeenCalledWith('g1', expect.any(Function))
    expect(withAutomergeItemChange).toHaveBeenCalledWith('p1', expect.any(Function))
    expect(requestAutomergeSync).toHaveBeenCalledWith(['g1', 'p1'])
    expect(mocks.pruneItemDrawers).toHaveBeenCalledWith(['p1'])
  })

  it('updates metadata locally', async () => {
    const result = await setMetadata({ prayerGoal: 20 } as any)

    expect(result.prayerGoal).toBe(20)
    expect(withAutomergeMetadataChange).toHaveBeenCalledTimes(1)
    expect(requestAutomergeSync).toHaveBeenCalledWith([ACCOUNT_METADATA_DOCUMENT_ID])
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getBlankGroup, getBlankPerson, type Item } from '../state/items'
import { mutateDeleteItems, mutateSetMetadata, mutateStoreItems } from './itemMutations'
import { emitDomainEvent } from '../events/domainEvents'
import {
  getAutomergeItems,
  initializeAutomergeDocStore,
  withAutomergeItemChange,
} from '../sync/automergeDocStore'
import { requestAutomergeSync } from '../sync/automergeSyncDispatcher'
import { setMetadata } from './vault/client'
import { fetchItems } from './itemReadService'

vi.mock('../sync/automergeDocStore', async importOriginal => {
  const actual = await importOriginal<typeof import('../sync/automergeDocStore')>()
  return {
    ...actual,
    getAutomergeItems: vi.fn(() => []),
    initializeAutomergeDocStore: vi.fn(),
    withAutomergeItemChange: vi.fn(async () => undefined),
  }
})

vi.mock('../sync/automergeSyncDispatcher', () => ({
  requestAutomergeSync: vi.fn(),
}))

vi.mock('./util', () => ({
  getAccountId: vi.fn(() => 'test-account'),
}))

vi.mock('./vault/client', async importOriginal => {
  const actual = await importOriginal<typeof import('./vault/client')>()
  return {
    ...actual,
    setMetadata: vi.fn(),
  }
})

vi.mock('../events/domainEvents', () => ({
  emitDomainEvent: vi.fn(),
}))

vi.mock('./itemReadService', async importOriginal => {
  const actual = await importOriginal<typeof import('./itemReadService')>()
  return {
    ...actual,
    fetchItems: vi.fn(),
  }
})

describe('local-first mutations', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(fetchItems).mockResolvedValue([])
    vi.mocked(getAutomergeItems).mockReturnValue([])
    vi.mocked(setMetadata).mockResolvedValue()
  })

  it('stores single-item snapshots and requests sync', async () => {
    const item = getBlankPerson('p1')

    const result = await mutateStoreItems(item)

    expect(result[0].id).toBe('p1')
    expect(initializeAutomergeDocStore).toHaveBeenCalledWith('test-account')
    expect(withAutomergeItemChange).toHaveBeenCalledWith('p1', expect.any(Function))
    expect(requestAutomergeSync).toHaveBeenCalledWith(['p1'])
  })

  it('validates incoming item payloads with zod before storing', async () => {
    await expect(mutateStoreItems({ id: 'bad-item', type: 'person' } as unknown as Item)).rejects.toBeTruthy()
    expect(withAutomergeItemChange).not.toHaveBeenCalled()
  })

  it('stores batch updates and requests sync for all ids', async () => {
    const first = getBlankPerson('p1')
    const second = getBlankPerson('p2')

    await mutateStoreItems([first, second])

    expect(withAutomergeItemChange).toHaveBeenCalledTimes(2)
    expect(withAutomergeItemChange).toHaveBeenCalledWith('p1', expect.any(Function))
    expect(withAutomergeItemChange).toHaveBeenCalledWith('p2', expect.any(Function))
    expect(requestAutomergeSync).toHaveBeenCalledWith(['p1', 'p2'])
  })

  it('deletes with group updates and tombstones and emits item delete event', async () => {
    const group = {
      ...getBlankGroup('g1', false),
      members: ['p1'],
    }
    const person = getBlankPerson('p1', false)

    vi.mocked(fetchItems).mockResolvedValue([group, person])

    await mutateDeleteItems('p1')

    expect(fetchItems).toHaveBeenCalledTimes(1)
    expect(withAutomergeItemChange).toHaveBeenCalledWith('g1', expect.any(Function))
    expect(withAutomergeItemChange).toHaveBeenCalledWith('p1', expect.any(Function))
    expect(requestAutomergeSync).toHaveBeenCalledWith(['g1', 'p1'])
    expect(emitDomainEvent).toHaveBeenCalledWith({
      type: 'data:deleted',
      domain: 'items',
      ids: ['p1'],
    })
  })

  it('pushes metadata updates directly to vault client', async () => {
    const result = await mutateSetMetadata({ prayerGoal: 20 } as any)

    expect(result.prayerGoal).toBe(20)
    expect(setMetadata).toHaveBeenCalledWith(expect.objectContaining({ prayerGoal: 20 }))
    expect(emitDomainEvent).toHaveBeenCalledWith({
      type: 'data:updated',
      domain: 'metadata',
      reason: 'automerge:metadata-updated',
    })
  })
})

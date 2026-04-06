import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getQueryKey } from '@trpc/react-query'
import { getBlankGroup, getBlankPerson, type Item } from '../state/items'
import { queryClient } from './queryClient'
import { trpc } from './trpc'
import { mutateDeleteItems, mutateSetMetadata, mutateStoreItems } from './itemMutations'
import { serializeItemAsBranch } from './vault/serializeItemAsBranch'
import { enqueueMutation, processOfflineQueue, CONFLICT_HANDLER_AUTOMERGE_ITEMS } from '../sync/offlineQueue'
import * as vault from './vault'
import { emitDomainEvent } from '../events/domainEvents'

const mocks = vi.hoisted(() => ({
  fetchItems: vi.fn(),
}))

vi.mock('../sync/offlineQueue', async importOriginal => {
  const actual = await importOriginal<typeof import('../sync/offlineQueue')>()
  return {
    ...actual,
    enqueueMutation: vi.fn(),
    processOfflineQueue: vi.fn(),
  }
})

vi.mock('./vault/serializeItemAsBranch', () => ({
  serializeItemAsBranch: vi.fn(),
}))

vi.mock('./util', () => ({
  getAccountId: vi.fn(() => 'test-account'),
}))

vi.mock('./vault', () => ({
  encryptObjectAsAutomerge: vi.fn().mockResolvedValue({
    encryptedAutomergeDoc: 'metadata-doc',
    versionId: 'metadata-v1',
  }),
}))

vi.mock('../events/domainEvents', () => ({
  emitDomainEvent: vi.fn(),
}))

vi.mock('./itemReadService', () => ({
  fetchItems: mocks.fetchItems,
}))

const itemsQueryKey = getQueryKey(trpc.items.fetchMany)

describe('local-first mutations', () => {
  beforeEach(() => {
    queryClient.clear()
    vi.clearAllMocks()
    mocks.fetchItems.mockResolvedValue([])

    vi.mocked(serializeItemAsBranch).mockImplementation(async item => ({
      branches: [{
        encryptedAutomergeDoc: `doc-${item.id}`,
        versionId: `v-${item.id}`,
        parentIds: [],
      }],
    }))

    vi.mocked(vault.encryptObjectAsAutomerge).mockResolvedValue({
      encryptedAutomergeDoc: 'metadata-doc',
      versionId: 'metadata-v1',
    })
  })

  it('enqueues single-item put mutations', async () => {
    const item = getBlankPerson('p1')

    const result = await mutateStoreItems(item)

    expect(result[0].id).toBe('p1')
    expect(queryClient.getQueryData<Item[]>(itemsQueryKey)).toBeUndefined()

    expect(enqueueMutation).toHaveBeenCalledWith(
      'items.put',
      expect.objectContaining({
        account: 'test-account',
        item: 'p1',
        branches: expect.any(Array),
      }),
      expect.objectContaining({
        conflictHandlerKey: CONFLICT_HANDLER_AUTOMERGE_ITEMS,
      }),
    )
    expect(processOfflineQueue).toHaveBeenCalledTimes(1)
  })

  it('validates incoming item payloads with zod before queueing', async () => {
    await expect(mutateStoreItems({ id: 'bad-item', type: 'person' } as unknown as Item)).rejects.toBeTruthy()
    expect(enqueueMutation).not.toHaveBeenCalled()
  })

  it('enqueues batch updates as putMany mutations', async () => {
    const first = getBlankPerson('p1')
    const second = getBlankPerson('p2')

    await mutateStoreItems([first, second])

    expect(enqueueMutation).toHaveBeenCalledWith(
      'items.putMany',
      expect.objectContaining({
        account: 'test-account',
        items: expect.arrayContaining([
          expect.objectContaining({ id: 'p1' }),
          expect.objectContaining({ id: 'p2' }),
        ]),
      }),
      expect.objectContaining({
        conflictHandlerKey: CONFLICT_HANDLER_AUTOMERGE_ITEMS,
      }),
    )
  })

  it('deletes by queueing group updates and tombstones and emits item delete event', async () => {
    const group = {
      ...getBlankGroup('g1', false),
      members: ['p1'],
    }
    const person = getBlankPerson('p1', false)

    mocks.fetchItems.mockResolvedValue([group, person])

    await mutateDeleteItems('p1')

    expect(enqueueMutation).toHaveBeenCalledWith(
      'items.putMany',
      expect.objectContaining({
        items: expect.arrayContaining([
          expect.objectContaining({ id: 'g1', deleted: undefined }),
          expect.objectContaining({ id: 'p1', deleted: true }),
        ]),
      }),
      expect.objectContaining({
        conflictHandlerKey: CONFLICT_HANDLER_AUTOMERGE_ITEMS,
      }),
    )
    expect(emitDomainEvent).toHaveBeenCalledWith({
      type: 'data:deleted',
      domain: 'items',
      ids: ['p1'],
    })
  })

  it('enqueues encrypted metadata branches', async () => {
    const result = await mutateSetMetadata({ prayerGoal: 20 } as any)

    expect(result.prayerGoal).toBe(20)

    expect(enqueueMutation).toHaveBeenCalledWith(
      'accounts.updateMetadata',
      expect.objectContaining({
        account: 'test-account',
        metadata: expect.objectContaining({
          branches: expect.any(Array),
        }),
      }),
    )
    expect(processOfflineQueue).toHaveBeenCalledTimes(1)
  })
})

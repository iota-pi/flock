import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getQueryKey } from '@trpc/react-query'
import { getBlankGroup, getBlankPerson, type Item } from '../state/items'
import { queryClient } from './queryClient'
import { trpc } from './trpc'
import { mutateDeleteItems, mutateSetMetadata, mutateStoreItems } from './itemMutations'
import { serializeItemAsBranch } from './vault/serializeItemAsBranch'
import { enqueueMutation, processOfflineQueue, CONFLICT_HANDLER_AUTOMERGE_ITEMS } from '../sync/offlineQueue'
import * as vault from './vault'

const mocks = vi.hoisted(() => ({
  pruneItemDrawers: vi.fn(),
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

vi.mock('../state/uiStore', () => ({
  useUiStore: {
    getState: () => ({
      pruneItemDrawers: mocks.pruneItemDrawers,
    }),
  },
}))

vi.mock('./itemReadService', () => ({
  fetchItems: mocks.fetchItems,
}))

const itemsQueryKey = getQueryKey(trpc.items.fetchMany)
const metadataQueryKey = getQueryKey(trpc.accounts.getMetadata)

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

  it('optimistically updates cache and enqueues single-item put mutations', async () => {
    const item = getBlankPerson('p1')

    const result = await mutateStoreItems(item)

    expect(result[0].id).toBe('p1')
    expect(queryClient.getQueryData<Item[]>(itemsQueryKey)?.[0]?.id).toBe('p1')

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

  it('rolls back optimistic cache update when enqueue fails', async () => {
    const existing = getBlankPerson('p-existing')
    queryClient.setQueryData(itemsQueryKey, [existing])

    vi.mocked(enqueueMutation).mockRejectedValueOnce(new Error('queue failure'))

    await expect(mutateStoreItems({ ...existing, name: 'Updated' })).rejects.toThrow('queue failure')

    const cached = queryClient.getQueryData<Item[]>(itemsQueryKey)
    expect(cached?.[0]?.name).toBe(existing.name)
  })

  it('deletes by queueing group updates and tombstones, then prunes drawers', async () => {
    const group = {
      ...getBlankGroup('g1', false),
      members: ['p1'],
    }
    const person = getBlankPerson('p1', false)

    queryClient.setQueryData(itemsQueryKey, [group, person])

    await mutateDeleteItems('p1')

    const cached = queryClient.getQueryData<Item[]>(itemsQueryKey) || []
    expect(cached.find(item => item.id === 'p1')).toBeUndefined()
    expect((cached.find(item => item.id === 'g1') as typeof group | undefined)?.members).toEqual([])

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
    expect(mocks.pruneItemDrawers).toHaveBeenCalledWith(['p1'])
  })

  it('optimistically updates metadata and enqueues encrypted metadata branches', async () => {
    queryClient.setQueryData(metadataQueryKey, { prayerGoal: 10 })

    const result = await mutateSetMetadata(prev => ({ ...prev, prayerGoal: 20 }))

    expect(result.prayerGoal).toBe(20)
    expect(queryClient.getQueryData(metadataQueryKey)).toEqual({ prayerGoal: 20 })

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

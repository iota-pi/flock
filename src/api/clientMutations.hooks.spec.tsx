import type { ReactNode } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'
import { getQueryKey } from '@trpc/react-query'
import {
  act,
  renderHook,
  waitFor,
} from '@testing-library/react'
import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { getBlankGroup, getBlankPerson, type Item } from '../state/items'
import { queryClient } from './queryClient'
import {
  useDeleteItemsMutation,
  useSetMetadataMutation,
  useStoreItemsMutation,
} from './itemMutations'
import { enqueueMutation } from '../sync/offlineQueue'
import { trpc } from './trpc'
import { emitDomainEvent } from '../events/domainEvents'
import { serializeItemAsBranch } from './vault/serializeItemAsBranch'

vi.mock('../sync/offlineQueue', async importOriginal => {
  const actual = await importOriginal<typeof import('../sync/offlineQueue')>()
  return {
    ...actual,
    enqueueMutation: vi.fn(),
    processOfflineQueue: vi.fn(),
  }
})

vi.mock('./util', () => ({
  getAccountId: vi.fn(() => 'test-account'),
}))

vi.mock('./vault/serializeItemAsBranch', () => ({
  serializeItemAsBranch: vi.fn(),
}))

vi.mock('./vault', () => ({
  encryptObjectAsAutomerge: vi.fn().mockResolvedValue({
    encryptedAutomergeDoc: 'metadata-doc',
    versionId: 'metadata-v1',
  }),
}))

vi.mock('../events/domainEvents', async importOriginal => {
  const actual = await importOriginal<typeof import('../events/domainEvents')>()
  return {
    ...actual,
    emitDomainEvent: vi.fn(),
  }
})

function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      {children}
    </QueryClientProvider>
  )
}

const itemsQueryKey = getQueryKey(trpc.items.fetchMany)
const metadataQueryKey = getQueryKey(trpc.accounts.getMetadata)

describe('item mutation hooks', () => {
  beforeEach(() => {
    queryClient.clear()
    vi.clearAllMocks()

    vi.mocked(serializeItemAsBranch).mockImplementation(async item => ({
      branches: [{
        encryptedAutomergeDoc: `doc-${item.id}`,
        versionId: `v-${item.id}`,
        parentIds: [],
      }],
    }))
  })

  it('rolls back items cache when store mutation enqueue fails', async () => {
    const existing = getBlankPerson('p1', false)
    queryClient.setQueryData<Item[]>(itemsQueryKey, [existing])

    vi.mocked(enqueueMutation).mockRejectedValueOnce(new Error('queue failure'))

    const { result } = renderHook(() => useStoreItemsMutation(), { wrapper })
    const updated = { ...existing, name: 'Updated' }

    await act(async () => {
      await expect(result.current.mutateAsync(updated)).rejects.toThrow('queue failure')
    })

    expect(queryClient.getQueryData<Item[]>(itemsQueryKey)?.[0]?.name).toBe(existing.name)
  })

  it('rolls back metadata cache when metadata enqueue fails', async () => {
    queryClient.setQueryData(metadataQueryKey, { prayerGoal: 10 })
    vi.mocked(enqueueMutation).mockRejectedValueOnce(new Error('metadata queue failure'))

    const { result } = renderHook(() => useSetMetadataMutation(), { wrapper })

    await act(async () => {
      await expect(result.current.mutateAsync(prev => ({ ...prev, prayerGoal: 20 }))).rejects.toThrow(
        'metadata queue failure',
      )
    })

    expect(queryClient.getQueryData(metadataQueryKey)).toEqual({ prayerGoal: 10 })
  })

  it('optimistically removes deleted items and emits deletion domain event', async () => {
    const group = {
      ...getBlankGroup('g1', false),
      members: ['p1'],
    }
    const person = getBlankPerson('p1', false)
    queryClient.setQueryData(itemsQueryKey, [group, person])

    const { result } = renderHook(() => useDeleteItemsMutation(), { wrapper })

    await act(async () => {
      await result.current.mutateAsync('p1')
    })

    await waitFor(() => {
      const cached = queryClient.getQueryData<Item[]>(itemsQueryKey) || []
      expect(cached.find(item => item.id === 'p1')).toBeUndefined()
    })

    expect(emitDomainEvent).toHaveBeenCalledWith({
      type: 'data:deleted',
      domain: 'items',
      ids: ['p1'],
    })
  })

  it('exposes mutation error state when save fails', async () => {
    const existing = getBlankPerson('p1', false)
    queryClient.setQueryData<Item[]>(itemsQueryKey, [existing])
    vi.mocked(enqueueMutation).mockRejectedValueOnce(new Error('save failed'))

    const { result } = renderHook(() => useStoreItemsMutation(), { wrapper })

    await act(async () => {
      await expect(result.current.mutateAsync({ ...existing, name: 'Will Roll Back' })).rejects.toThrow('save failed')
    })

    await waitFor(() => {
      expect(result.current.error?.message).toBe('save failed')
    })
  })
})

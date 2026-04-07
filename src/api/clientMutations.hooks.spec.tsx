import type { ReactNode } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'
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
import { getBlankGroup, getBlankPerson } from '../state/items'
import { queryClient } from './queryClient'
import {
  useDeleteItemsMutation,
  useSetMetadataMutation,
  useStoreItemsMutation,
} from './itemMutations'
import { emitDomainEvent } from '../events/domainEvents'
import {
  getAutomergeItems,
  initializeAutomergeDocStore,
  upsertAutomergeItemSnapshot,
} from '../sync/automergeDocStore'
import { requestAutomergeSync } from '../sync/automergeSyncDispatcher'
import { setMetadata } from './vault/client'
import { fetchItems } from './itemReadService'
import { handleVaultError } from './runtime'

vi.mock('../sync/automergeDocStore', async importOriginal => {
  const actual = await importOriginal<typeof import('../sync/automergeDocStore')>()
  return {
    ...actual,
    getAutomergeItems: vi.fn(() => []),
    initializeAutomergeDocStore: vi.fn(),
    upsertAutomergeItemSnapshot: vi.fn(),
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

vi.mock('./itemReadService', async importOriginal => {
  const actual = await importOriginal<typeof import('./itemReadService')>()
  return {
    ...actual,
    fetchItems: vi.fn(),
  }
})

vi.mock('./runtime', async importOriginal => {
  const actual = await importOriginal<typeof import('./runtime')>()
  return {
    ...actual,
    handleVaultError: vi.fn(),
  }
})

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

describe('item mutation hooks', () => {
  beforeEach(() => {
    queryClient.clear()
    vi.clearAllMocks()
    vi.mocked(fetchItems).mockResolvedValue([])
    vi.mocked(getAutomergeItems).mockReturnValue([])
    vi.mocked(setMetadata).mockResolvedValue()
  })

  it('exposes mutation error state when automerge store save fails', async () => {
    vi.mocked(upsertAutomergeItemSnapshot).mockRejectedValueOnce(new Error('save failed'))

    const { result } = renderHook(() => useStoreItemsMutation(), { wrapper })
    const updated = { ...getBlankPerson('p1', false), name: 'Updated' }

    await act(async () => {
      await expect(result.current.mutateAsync(updated)).rejects.toThrow('save failed')
    })

    await waitFor(() => {
      expect(result.current.error?.message).toBe('save failed')
    })

    expect(handleVaultError).toHaveBeenCalledWith(expect.any(Error), 'Failed to save items')
  })

  it('exposes mutation error state when metadata push fails', async () => {
    vi.mocked(setMetadata).mockRejectedValueOnce(new Error('metadata save failed'))

    const { result } = renderHook(() => useSetMetadataMutation(), { wrapper })

    await act(async () => {
      await expect(result.current.mutateAsync(prev => ({ ...prev, prayerGoal: 20 }))).rejects.toThrow(
        'metadata save failed',
      )
    })

    await waitFor(() => {
      expect(result.current.error?.message).toBe('metadata save failed')
    })

    expect(handleVaultError).toHaveBeenCalledWith(expect.any(Error), 'Failed to save settings')
  })

  it('stores deletes as updates and emits deletion domain event', async () => {
    const group = {
      ...getBlankGroup('g1', false),
      members: ['p1'],
    }
    const person = getBlankPerson('p1', false)
    vi.mocked(fetchItems).mockResolvedValue([group, person])

    const { result } = renderHook(() => useDeleteItemsMutation(), { wrapper })

    await act(async () => {
      await result.current.mutateAsync('p1')
    })

    expect(initializeAutomergeDocStore).toHaveBeenCalledWith('test-account')
    expect(upsertAutomergeItemSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'g1', members: [] }),
    )
    expect(upsertAutomergeItemSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'p1', deleted: true }),
    )
    expect(requestAutomergeSync).toHaveBeenCalledWith(['g1', 'p1'])

    expect(emitDomainEvent).toHaveBeenCalledWith({
      type: 'data:deleted',
      domain: 'items',
      ids: ['p1'],
    })
  })

  it('requests sync when a store mutation succeeds', async () => {
    const existing = getBlankPerson('p1', false)

    const { result } = renderHook(() => useStoreItemsMutation(), { wrapper })

    await act(async () => {
      await result.current.mutateAsync({ ...existing, name: 'Saved' })
    })

    expect(upsertAutomergeItemSnapshot).toHaveBeenCalledWith(expect.objectContaining({ id: 'p1', name: 'Saved' }))
    expect(requestAutomergeSync).toHaveBeenCalledWith(['p1'])
  })
})

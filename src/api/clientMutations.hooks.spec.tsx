import type { ReactNode } from 'react'
import { QueryClientProvider, useMutation } from '@tanstack/react-query'
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
import { getBlankPerson } from '../state/items'
import { queryClient } from './queryClient'
import * as mutations from './clientMutations'

vi.mock('./clientMutations', async importOriginal => {
  const actual = await importOriginal<typeof import('./clientMutations')>()
  return {
    ...actual,
    mutateStoreItems: vi.fn(),
  }
})

function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      {children}
    </QueryClientProvider>
  )
}

describe('useStoreItemsMutation', () => {
  beforeEach(() => {
    queryClient.clear()
    vi.clearAllMocks()
  })

  it('updates the items cache optimistically before the mutation resolves', async () => {
    const updatedItem = { ...getBlankPerson(), name: 'Prayed For' }
    vi.mocked(mutations.mutateStoreItems).mockResolvedValue([updatedItem])
    const { result } = renderHook(() => useMutation({ mutationFn: mutations.mutateStoreItems }), { wrapper })

    await act(async () => {
      await result.current.mutateAsync(updatedItem)
    })

    expect(mutations.mutateStoreItems).toHaveBeenCalledWith(updatedItem, expect.any(Object))
  })

  it('exposes mutation error state when save fails', async () => {
    const updatedItem = { ...getBlankPerson(), name: 'Will Roll Back' }

    vi.mocked(mutations.mutateStoreItems).mockRejectedValue(new Error('save failed'))

    const { result } = renderHook(() => useMutation({ mutationFn: mutations.mutateStoreItems }), { wrapper })

    await act(async () => {
      await expect(result.current.mutateAsync(updatedItem)).rejects.toThrow('save failed')
    })

    await waitFor(() => {
      expect(result.current.error?.message).toBe('save failed')
    })
  })
})

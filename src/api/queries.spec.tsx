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
import { getBlankPerson } from '../state/items'
import {
  queryClient,
  queryKeys,
} from './queryClient'
import { useStoreItemsMutation } from './queries'
import * as mutations from './mutations'

vi.mock('./mutations', async importOriginal => {
  const actual = await importOriginal<typeof import('./mutations')>()
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
    const existingItem = getBlankPerson()
    const updatedItem = { ...existingItem, name: 'Prayed For' }

    let resolveMutation: (() => void) | undefined
    vi.mocked(mutations.mutateStoreItems).mockImplementation(
      () => new Promise(resolve => {
        resolveMutation = () => resolve([updatedItem])
      }) as Promise<any>,
    )

    queryClient.setQueryData(queryKeys.items, [existingItem])

    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')
    const { result } = renderHook(() => useStoreItemsMutation(), { wrapper })

    act(() => {
      result.current.mutate(updatedItem)
    })

    await waitFor(() => {
      expect(queryClient.getQueryData(queryKeys.items)).toEqual([updatedItem])
    })

    expect(invalidateSpy).not.toHaveBeenCalled()

    resolveMutation?.()

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.items })
    })
  })

  it('rolls the items cache back when the mutation fails', async () => {
    const existingItem = getBlankPerson()
    const updatedItem = { ...existingItem, name: 'Will Roll Back' }

    vi.mocked(mutations.mutateStoreItems).mockRejectedValue(new Error('save failed'))

    queryClient.setQueryData(queryKeys.items, [existingItem])

    const { result } = renderHook(() => useStoreItemsMutation(), { wrapper })

    act(() => {
      result.current.mutate(updatedItem)
    })

    await waitFor(() => {
      expect(queryClient.getQueryData(queryKeys.items)).toEqual([existingItem])
    })
  })
})

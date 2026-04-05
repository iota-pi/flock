import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useOfflineRecovery } from './useOfflineRecovery'

const mocks = vi.hoisted(() => ({
  readDeadLetterQueue: vi.fn(),
  readQueue: vi.fn(),
  writeDeadLetterQueue: vi.fn(),
  writeQueue: vi.fn(),
  processOfflineQueue: vi.fn(),
  setDlqCount: vi.fn(),
  setOfflineQueueLength: vi.fn(),
  setMessage: vi.fn(),
  invalidateItems: vi.fn(),
  putMutateAsync: vi.fn(),
  resolveBranchConflictMutateAsync: vi.fn(),
}))

vi.mock('../api/trpc', () => ({
  trpc: {
    items: {
      fetchMany: {},
      put: {
        useMutation: () => ({
          mutateAsync: mocks.putMutateAsync,
        }),
      },
      resolveBranchConflict: {
        useMutation: () => ({
          mutateAsync: mocks.resolveBranchConflictMutateAsync,
        }),
      },
    },
    accounts: {
      getMetadata: {},
    },
    useUtils: () => ({
      items: {
        fetchMany: {
          invalidate: mocks.invalidateItems,
        },
      },
    }),
  },
}))

vi.mock('../sync/offlineQueueStore', () => ({
  readDeadLetterQueue: mocks.readDeadLetterQueue,
  readQueue: mocks.readQueue,
  writeDeadLetterQueue: mocks.writeDeadLetterQueue,
  writeQueue: mocks.writeQueue,
}))

vi.mock('../sync/offlineQueue', () => ({
  processOfflineQueue: mocks.processOfflineQueue,
}))

vi.mock('../api/queryClient', () => ({
  queryClient: {
    getQueryData: vi.fn(),
  },
}))

vi.mock('../state/syncStore', () => ({
  useSyncStore: (selector: (state: { setDlqCount: typeof mocks.setDlqCount, setOfflineQueueLength: typeof mocks.setOfflineQueueLength }) => unknown) => (
    selector({
      setDlqCount: mocks.setDlqCount,
      setOfflineQueueLength: mocks.setOfflineQueueLength,
    })
  ),
}))

vi.mock('../state/toastStore', () => ({
  useToastStore: (selector: (state: { setMessage: typeof mocks.setMessage }) => unknown) => (
    selector({
      setMessage: mocks.setMessage,
    })
  ),
}))

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  })

  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        {children}
      </QueryClientProvider>
    )
  }
}

describe('useOfflineRecovery', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('loads dead letter items from storage', async () => {
    const failedMutations = [
      { id: 'm1', mutationType: 'items.put', payload: {}, endpoint: 'x' },
      { id: 'm2', mutationType: 'items.put', payload: {}, endpoint: 'x' },
    ]
    mocks.readDeadLetterQueue.mockResolvedValue(failedMutations)

    const { result } = renderHook(() => useOfflineRecovery(), {
      wrapper: createWrapper(),
    })

    await waitFor(() => {
      expect(result.current.deadLetterItems).toEqual(failedMutations)
    })
  })

  it('discards a dead letter mutation and updates dlq count', async () => {
    mocks.readDeadLetterQueue.mockResolvedValue([
      { id: 'm1', mutationType: 'items.put', payload: {}, endpoint: 'x' },
      { id: 'm2', mutationType: 'items.put', payload: {}, endpoint: 'x' },
    ])
    mocks.writeDeadLetterQueue.mockResolvedValue(undefined)

    const { result } = renderHook(() => useOfflineRecovery(), {
      wrapper: createWrapper(),
    })

    await waitFor(() => {
      expect(result.current.deadLetterItems.length).toBe(2)
    })

    await act(async () => {
      await result.current.handleDiscardDeadLetterMutation('m1')
    })

    expect(mocks.writeDeadLetterQueue).toHaveBeenCalledWith([
      { id: 'm2', mutationType: 'items.put', payload: {}, endpoint: 'x' },
    ])
    expect(mocks.setDlqCount).toHaveBeenCalledWith(1)
  })

  it('retries a dead letter mutation and clears retrying state', async () => {
    const mutation = { id: 'm1', mutationType: 'items.put', payload: { item: 'a' }, endpoint: 'x' }
    mocks.readDeadLetterQueue
      .mockResolvedValueOnce([mutation])
      .mockResolvedValueOnce([mutation])
      .mockResolvedValue([])
    mocks.readQueue.mockResolvedValue([{ id: 'q1', mutationType: 'items.put', payload: {}, endpoint: 'x' }])
    mocks.writeQueue.mockResolvedValue(undefined)
    mocks.writeDeadLetterQueue.mockResolvedValue(undefined)
    mocks.processOfflineQueue.mockResolvedValue(undefined)

    const { result } = renderHook(() => useOfflineRecovery(), {
      wrapper: createWrapper(),
    })

    await waitFor(() => {
      expect(result.current.deadLetterItems.length).toBe(1)
    })

    await act(async () => {
      await result.current.handleRetryDeadLetterMutation('m1')
    })

    expect(mocks.writeQueue).toHaveBeenCalledWith([
      { id: 'q1', mutationType: 'items.put', payload: {}, endpoint: 'x' },
      mutation,
    ])
    expect(mocks.writeDeadLetterQueue).toHaveBeenCalledWith([])
    expect(mocks.setOfflineQueueLength).toHaveBeenCalledWith(2)
    expect(mocks.setDlqCount).toHaveBeenCalledWith(0)
    expect(mocks.processOfflineQueue).toHaveBeenCalledTimes(1)
    expect(result.current.isRetrying).toBe(null)
  })

  it('retries a corrupted item by removing manual recovery marker and invalidating fetch cache', async () => {
    const itemId = 'item-corrupted-1'
    const manualRecoveryEntry = {
      id: 'm-recovery',
      mutationType: 'items.manualRecovery',
      payload: { itemId },
      endpoint: 'x',
    }
    const unrelatedEntry = {
      id: 'm-other',
      mutationType: 'items.put',
      payload: { item: 'other' },
      endpoint: 'x',
    }

    mocks.readDeadLetterQueue
      .mockResolvedValueOnce([manualRecoveryEntry, unrelatedEntry])
      .mockResolvedValueOnce([manualRecoveryEntry, unrelatedEntry])
      .mockResolvedValue([unrelatedEntry])
    mocks.writeDeadLetterQueue.mockResolvedValue(undefined)
    mocks.invalidateItems.mockResolvedValue(undefined)

    const { result } = renderHook(() => useOfflineRecovery(), {
      wrapper: createWrapper(),
    })

    await waitFor(() => {
      expect(result.current.deadLetterItems.length).toBe(2)
    })

    await act(async () => {
      await result.current.handleRetryCorruptedItem(itemId)
    })

    expect(mocks.writeDeadLetterQueue).toHaveBeenCalledWith([unrelatedEntry])
    expect(mocks.invalidateItems).toHaveBeenCalledTimes(1)
    expect(mocks.setMessage).toHaveBeenCalledWith({
      severity: 'info',
      message: `Retry sync triggered for ${itemId}.`,
    })
    expect(result.current.isRetrying).toBe(null)
  })
})

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
}))

vi.mock('../api/offlineQueueStore', () => ({
  readDeadLetterQueue: mocks.readDeadLetterQueue,
  readQueue: mocks.readQueue,
  writeDeadLetterQueue: mocks.writeDeadLetterQueue,
  writeQueue: mocks.writeQueue,
}))

vi.mock('../api/offlineQueue', () => ({
  processOfflineQueue: mocks.processOfflineQueue,
}))

vi.mock('../state/uiStore', () => ({
  useUiStore: (selector: (state: { setDlqCount: typeof mocks.setDlqCount, setOfflineQueueLength: typeof mocks.setOfflineQueueLength, setMessage: typeof mocks.setMessage }) => unknown) => (
    selector({
      setDlqCount: mocks.setDlqCount,
      setOfflineQueueLength: mocks.setOfflineQueueLength,
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
})

import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useOfflineRecovery } from './useOfflineRecovery'

const mocks = vi.hoisted(() => ({
  readManualRecoveryEntries: vi.fn(),
  readManualRecoveryCount: vi.fn(),
  removeManualRecoveryEntryById: vi.fn(),
  removeManualRecoveryEntryByItemId: vi.fn(),
  setRecoveryCount: vi.fn(),
  requestAutomergeSync: vi.fn(),
  setMessage: vi.fn(),
  getAutomergeItem: vi.fn(),
  withAutomergeItemChange: vi.fn(async () => undefined),
}))

vi.mock('../sync/manualRecoveryStore', () => ({
  readManualRecoveryEntries: mocks.readManualRecoveryEntries,
  readManualRecoveryCount: mocks.readManualRecoveryCount,
  removeManualRecoveryEntryById: mocks.removeManualRecoveryEntryById,
  removeManualRecoveryEntryByItemId: mocks.removeManualRecoveryEntryByItemId,
}))

vi.mock('../sync/automergeSyncDispatcher', () => ({
  requestAutomergeSync: mocks.requestAutomergeSync,
}))

vi.mock('../sync/automergeDocStore', () => ({
  getAutomergeItem: mocks.getAutomergeItem,
  withAutomergeItemChange: mocks.withAutomergeItemChange,
}))

vi.mock('../state/syncStore', () => ({
  useSyncStore: (selector: (state: { setRecoveryCount: typeof mocks.setRecoveryCount }) => unknown) => (
    selector({
      setRecoveryCount: mocks.setRecoveryCount,
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

  it('loads manual recovery entries from storage', async () => {
    const failedEntries = [
      { id: 'r1', itemId: 'item-1', reason: 'failed', createdAt: 1 },
      { id: 'r2', itemId: 'item-2', reason: 'failed', createdAt: 2 },
    ]
    mocks.readManualRecoveryEntries.mockResolvedValue(failedEntries)

    const { result } = renderHook(() => useOfflineRecovery(), {
      wrapper: createWrapper(),
    })

    await waitFor(() => {
      expect(result.current.recoveryItems).toEqual(failedEntries)
    })
    expect(mocks.setRecoveryCount).toHaveBeenCalledWith(2)
  })

  it('dismisses a recovery entry and refreshes recovery count', async () => {
    mocks.readManualRecoveryEntries.mockResolvedValue([{ id: 'r1', itemId: 'item-1', reason: 'failed', createdAt: 1 }])
    mocks.readManualRecoveryCount.mockResolvedValue(0)
    mocks.removeManualRecoveryEntryById.mockResolvedValue(undefined)

    const { result } = renderHook(() => useOfflineRecovery(), {
      wrapper: createWrapper(),
    })

    await waitFor(() => {
      expect(result.current.recoveryItems.length).toBe(1)
    })

    await act(async () => {
      await result.current.handleDismissRecoveryItem('r1')
    })

    expect(mocks.removeManualRecoveryEntryById).toHaveBeenCalledWith('r1')
    expect(mocks.setRecoveryCount).toHaveBeenCalledWith(0)
  })

  it('retries a corrupted item and requests sync', async () => {
    const entry = { id: 'r1', itemId: 'item-corrupted-1', reason: 'failed', createdAt: 1 }
    mocks.readManualRecoveryEntries.mockResolvedValue([entry])
    mocks.readManualRecoveryCount.mockResolvedValue(0)
    mocks.removeManualRecoveryEntryByItemId.mockResolvedValue(undefined)

    const { result } = renderHook(() => useOfflineRecovery(), {
      wrapper: createWrapper(),
    })

    await waitFor(() => {
      expect(result.current.recoveryItems.length).toBe(1)
    })

    await act(async () => {
      await result.current.handleRetryCorruptedItem('item-corrupted-1')
    })

    expect(mocks.removeManualRecoveryEntryByItemId).toHaveBeenCalledWith('item-corrupted-1')
    expect(mocks.requestAutomergeSync).toHaveBeenCalledWith(['item-corrupted-1'])
    expect(mocks.setMessage).toHaveBeenCalledWith({
      severity: 'info',
      message: 'Retry sync triggered for item-corrupted-1.',
    })
    expect(result.current.isRetrying).toBe(null)
  })

  it('force overwrite applies local item snapshot and requests sync', async () => {
    const entry = { id: 'r1', itemId: 'item-1', reason: 'failed', createdAt: 1 }
    mocks.readManualRecoveryEntries.mockResolvedValue([entry])
    mocks.readManualRecoveryCount.mockResolvedValue(0)
    mocks.removeManualRecoveryEntryByItemId.mockResolvedValue(undefined)
    mocks.getAutomergeItem.mockReturnValue({
      id: 'item-1',
      type: 'person',
      name: 'Alice',
      prayedFor: [],
      notes: [],
      description: '',
      archived: false,
      created: 0,
      prayerFrequency: 'none',
    })

    const { result } = renderHook(() => useOfflineRecovery(), {
      wrapper: createWrapper(),
    })

    await act(async () => {
      await result.current.handleForceOverwriteCorruptedItem('item-1')
    })

    expect(mocks.withAutomergeItemChange).toHaveBeenCalledWith('item-1', expect.any(Function))
    expect(mocks.requestAutomergeSync).toHaveBeenCalledWith(['item-1'])
  })
})

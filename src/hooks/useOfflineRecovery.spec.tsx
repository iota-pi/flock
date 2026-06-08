import { act, renderHook, waitFor } from '@testing-library/react'
import { useDataRecovery } from './useDataRecovery'
import { ItemId } from 'src/shared/schemas/items'


const mocks = vi.hoisted(() => ({
  setMessage: vi.fn(),
  dismissRecoveryItem: vi.fn(),
  retryRecoveryItem: vi.fn(),
  forceOverwriteRecoveryItem: vi.fn(),
  forceDeleteRecoveryItem: vi.fn(),
  listRecoveryItems: vi.fn(),
  subscribeRecoveryItems: vi.fn(),
  shutdown: vi.fn(),
}))

vi.mock('../sync/client/SyncBridge', () => ({
  SyncBridge: {
    dismissRecoveryItem: mocks.dismissRecoveryItem,
    retryRecoveryItem: mocks.retryRecoveryItem,
    forceOverwriteRecoveryItem: mocks.forceOverwriteRecoveryItem,
    forceDeleteRecoveryItem: mocks.forceDeleteRecoveryItem,
    listRecoveryItems: mocks.listRecoveryItems,
    subscribeRecoveryItems: mocks.subscribeRecoveryItems,
    shutdown: mocks.shutdown,
  },
}))

vi.mock('../state/toastStore', () => ({
  useToastStore: (selector: (state: { setMessage: typeof mocks.setMessage }) => unknown) => (
    selector({
      setMessage: mocks.setMessage,
    })
  ),
}))

describe('useDataRecovery', () => {
  let currentEntries: any[] = []

  beforeEach(() => {
    vi.clearAllMocks()
    currentEntries = []
    mocks.subscribeRecoveryItems.mockImplementation(listener => {
      listener(currentEntries)
      return () => {}
    })
  })

  it('loads manual recovery entries from storage', async () => {
    const failedEntries = [
      { id: 'r1', itemId: 'item-1', reason: 'failed', createdAt: 1 },
      { id: 'r2', itemId: 'item-2', reason: 'failed', createdAt: 2 },
    ]
    currentEntries = failedEntries
    mocks.listRecoveryItems.mockResolvedValue(failedEntries)

    const { result } = renderHook(() => useDataRecovery())

    await waitFor(() => {
      expect(result.current.recoveryItems).toEqual(failedEntries)
    })
  })

  it('dismisses a recovery entry and refreshes the recovery list', async () => {
    const failedEntries = [{ id: 'r1', itemId: 'item-1', reason: 'failed', createdAt: 1 }]
    currentEntries = failedEntries
    mocks.listRecoveryItems.mockResolvedValue(failedEntries)
    mocks.dismissRecoveryItem.mockResolvedValue(undefined)

    const { result } = renderHook(() => useDataRecovery())

    await waitFor(() => {
      expect(result.current.recoveryItems.length).toBe(1)
    })

    await act(async () => {
      await result.current.handleDismissRecoveryItem('r1')
    })

    expect(mocks.dismissRecoveryItem).toHaveBeenCalledWith('r1')
  })

  it('retries a corrupted item and updates status message', async () => {
    const failedEntries = [{ id: 'r1', itemId: 'item-corrupted-1', reason: 'failed', createdAt: 1 }]
    currentEntries = failedEntries
    mocks.listRecoveryItems.mockResolvedValue(failedEntries)
    mocks.retryRecoveryItem.mockResolvedValue(undefined)

    const { result } = renderHook(() => useDataRecovery())

    await waitFor(() => {
      expect(result.current.recoveryItems.length).toBe(1)
    })

    await act(async () => {
      await result.current.handleRetryCorruptedItem('item-corrupted-1' as ItemId)
    })

    expect(mocks.retryRecoveryItem).toHaveBeenCalledWith('item-corrupted-1')
    expect(mocks.setMessage).toHaveBeenCalledWith({
      severity: 'info',
      message: 'Retry queued for item-corrupted-1.',
    })
    expect(result.current.isRetrying).toBe(null)
  })

  it('force overwrite applies local item snapshot', async () => {
    const failedEntries = [{ id: 'r1', itemId: 'item-1', reason: 'failed', createdAt: 1 }]
    currentEntries = failedEntries
    mocks.listRecoveryItems.mockResolvedValue(failedEntries)
    mocks.forceOverwriteRecoveryItem.mockResolvedValue(undefined)

    const { result } = renderHook(() => useDataRecovery())

    await act(async () => {
      await result.current.handleForceOverwriteCorruptedItem('item-1' as ItemId)
    })

    expect(mocks.forceOverwriteRecoveryItem).toHaveBeenCalledWith('item-1')
  })
})


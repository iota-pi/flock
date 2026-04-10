import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useOfflineRecovery } from './useOfflineRecovery'

const mocks = vi.hoisted(() => ({
  readManualRecoveryEntries: vi.fn(),
  removeManualRecoveryEntryById: vi.fn(),
  removeManualRecoveryEntryByItemId: vi.fn(),
  requestAutomergeSync: vi.fn(),
  setMessage: vi.fn(),
  getAutomergeItem: vi.fn(),
  applyAutomergeItemPatches: vi.fn(async () => undefined),
}))

vi.mock('../sync/manualRecoveryStore', () => ({
  readManualRecoveryEntries: mocks.readManualRecoveryEntries,
  removeManualRecoveryEntryById: mocks.removeManualRecoveryEntryById,
  removeManualRecoveryEntryByItemId: mocks.removeManualRecoveryEntryByItemId,
}))

vi.mock('../sync/automergeSyncDispatcher', () => ({
  requestAutomergeSync: mocks.requestAutomergeSync,
}))

vi.mock('../sync/automergeDocStore', () => ({
  getAutomergeItem: mocks.getAutomergeItem,
  applyAutomergeItemPatches: mocks.applyAutomergeItemPatches,
}))

vi.mock('../state/toastStore', () => ({
  useToastStore: (selector: (state: { setMessage: typeof mocks.setMessage }) => unknown) => (
    selector({
      setMessage: mocks.setMessage,
    })
  ),
}))

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

    const { result } = renderHook(() => useOfflineRecovery())

    await waitFor(() => {
      expect(result.current.recoveryItems).toEqual(failedEntries)
    })
  })

  it('dismisses a recovery entry and refreshes the recovery list', async () => {
    mocks.readManualRecoveryEntries.mockResolvedValue([{ id: 'r1', itemId: 'item-1', reason: 'failed', createdAt: 1 }])
    mocks.removeManualRecoveryEntryById.mockResolvedValue(undefined)

    const { result } = renderHook(() => useOfflineRecovery())

    await waitFor(() => {
      expect(result.current.recoveryItems.length).toBe(1)
    })

    await act(async () => {
      await result.current.handleDismissRecoveryItem('r1')
    })

    expect(mocks.removeManualRecoveryEntryById).toHaveBeenCalledWith('r1')
  })

  it('retries a corrupted item and requests sync', async () => {
    const entry = { id: 'r1', itemId: 'item-corrupted-1', reason: 'failed', createdAt: 1 }
    mocks.readManualRecoveryEntries.mockResolvedValue([entry])
    mocks.removeManualRecoveryEntryByItemId.mockResolvedValue(undefined)

    const { result } = renderHook(() => useOfflineRecovery())

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

    const { result } = renderHook(() => useOfflineRecovery())

    await act(async () => {
      await result.current.handleForceOverwriteCorruptedItem('item-1')
    })

    expect(mocks.applyAutomergeItemPatches).toHaveBeenCalledWith('item-1', expect.any(Array))
    expect(mocks.requestAutomergeSync).toHaveBeenCalledWith(['item-1'])
  })
})

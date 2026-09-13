import { SyncEventProcessor } from './SyncEventProcessor'
import { useAppStore } from 'src/state/store'
import type { ManualRecoveryEntry } from 'src/sync/shared/manualRecoveryStore'
import type { ItemId } from 'src/shared/schemas/items'

describe('SyncEventProcessor', () => {
  let processor: SyncEventProcessor
  let onKeyVersionMissing: ReturnType<typeof vi.fn<(kver?: string) => void>>
  let updateItemsSpy: any

  beforeEach(() => {
    useAppStore.setState({
      syncStatus: 'idle',
      fatalError: null,
      syncWarning: null,
      isQuotaExceeded: false,
      isLeaderConflict: false,
    })
    onKeyVersionMissing = vi.fn<(kver?: string) => void>()
    processor = new SyncEventProcessor({ onKeyVersionMissing })
    updateItemsSpy = vi.spyOn(useAppStore.getState(), 'updateItemsFromServer').mockImplementation(() => {})
  })

  afterEach(() => {
    processor.reset(true)
    updateItemsSpy?.mockRestore()
    vi.useRealTimers()
  })

  it('updates sync status on statusChange event', () => {
    processor.handleSyncEvent({ type: 'statusChange', status: 'syncing' })
    expect(useAppStore.getState().syncStatus).toBe('syncing')
  })

  it('batches item updates below ITEM_UPDATE_BATCH_MAX via setTimeout', async () => {
    vi.useFakeTimers()

    processor.handleSyncEvent({
      type: 'itemUpdated',
      id: 'item-1',
      item: { id: 'item-1', name: 'Item 1' } as any,
    })

    expect(updateItemsSpy).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(updateItemsSpy).toHaveBeenCalledWith([
      { id: 'item-1', item: expect.objectContaining({ id: 'item-1' }) },
    ])
  })

  it('flushes immediately when reaching ITEM_UPDATE_BATCH_MAX (50 items)', () => {
    for (let i = 0; i < 50; i++) {
      processor.handleSyncEvent({
        type: 'itemUpdated',
        id: `item-${i}`,
        item: { id: `item-${i}` } as any,
      })
    }

    expect(updateItemsSpy).toHaveBeenCalledTimes(1)
    expect(updateItemsSpy).toHaveBeenCalledWith(
      expect.arrayContaining([
        { id: 'item-0', item: expect.objectContaining({ id: 'item-0' }) },
        { id: 'item-49', item: expect.objectContaining({ id: 'item-49' }) },
      ])
    )
  })

  it('delegates keyVersionMissing event to callback', () => {
    processor.handleSyncEvent({ type: 'keyVersionMissing', kver: 'kver-42' })
    expect(onKeyVersionMissing).toHaveBeenCalledWith('kver-42')
  })

  it('handles quotaExceeded and quotaResolved events', () => {
    processor.handleSyncEvent({
      type: 'quotaExceeded',
      message: 'Storage quota exceeded',
    })
    expect(useAppStore.getState().syncStatus).toBe('degraded')
    expect(useAppStore.getState().isQuotaExceeded).toBe(true)
    expect(useAppStore.getState().syncWarning).toBe('Storage quota exceeded')

    processor.handleSyncEvent({ type: 'quotaResolved' })
    expect(useAppStore.getState().isQuotaExceeded).toBe(false)
    expect(useAppStore.getState().syncStatus).toBe('idle')
    expect(useAppStore.getState().syncWarning).toBeNull()
  })

  it('handles leaderConflict events', () => {
    processor.handleSyncEvent({ type: 'leaderConflict', hasConflict: true })
    expect(useAppStore.getState().isLeaderConflict).toBe(true)

    processor.handleSyncEvent({ type: 'leaderConflict', hasConflict: false })
    expect(useAppStore.getState().isLeaderConflict).toBe(false)
  })

  it('manages recovery entries and subscriber notifications', () => {
    const listener = vi.fn()
    const unsubscribe = processor.subscribeRecoveryItems(listener)

    // Initial subscribe invokes immediately with current entries
    expect(listener).toHaveBeenCalledWith([])

    const mockEntries: ManualRecoveryEntry[] = [
      { id: 'r1', itemId: 'item-1' as ItemId, reason: 'error', createdAt: 123 },
    ]
    processor.handleSyncEvent({ type: 'recoveryItemsChanged', entries: mockEntries })

    expect(processor.getRecoveryEntries()).toEqual(mockEntries)
    expect(listener).toHaveBeenCalledWith(mockEntries)

    unsubscribe()
    processor.handleSyncEvent({ type: 'recoveryItemsChanged', entries: [] })
    expect(listener).toHaveBeenCalledTimes(2) // Not called after unsubscribe
  })

  it('resets state on reset()', async () => {
    vi.useFakeTimers()

    processor.handleSyncEvent({
      type: 'itemUpdated',
      id: 'item-cancelled',
      item: { id: 'item-cancelled' } as any,
    })

    processor.reset(true)

    await vi.advanceTimersByTimeAsync(50)
    expect(updateItemsSpy).not.toHaveBeenCalled()
    expect(processor.getRecoveryEntries()).toEqual([])
  })
})

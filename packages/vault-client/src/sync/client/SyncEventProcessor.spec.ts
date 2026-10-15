import { SyncEventProcessor } from './SyncEventProcessor'
import { createFakeSink, createFakeTelemetry } from './__test__/fakeHost'
import type { ManualRecoveryEntry } from '../shared/manualRecoveryStore'
import type { ItemId } from '@vault/shared'

describe('SyncEventProcessor', () => {
  let processor: SyncEventProcessor
  let onKeyVersionMissing: ReturnType<typeof vi.fn<(kver?: string) => void>>
  let sink: ReturnType<typeof createFakeSink>
  let telemetry: ReturnType<typeof createFakeTelemetry>
  let updateItemsSpy: ReturnType<typeof createFakeSink>['updateItems']

  beforeEach(() => {
    sink = createFakeSink()
    telemetry = createFakeTelemetry()
    onKeyVersionMissing = vi.fn<(kver?: string) => void>()
    processor = new SyncEventProcessor(sink, { onKeyVersionMissing }, telemetry)
    updateItemsSpy = sink.updateItems
  })

  afterEach(() => {
    processor.reset(true)
    vi.useRealTimers()
  })

  it('updates sync status on statusChange event', () => {
    processor.handleSyncEvent({ type: 'statusChange', status: 'syncing' })
    expect(sink.state.syncStatus).toBe('syncing')
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
    expect(sink.state.syncStatus).toBe('degraded')
    expect(sink.state.isQuotaExceeded).toBe(true)
    expect(sink.state.syncWarning).toBe('Storage quota exceeded')

    processor.handleSyncEvent({ type: 'quotaResolved' })
    expect(sink.state.isQuotaExceeded).toBe(false)
    expect(sink.state.syncStatus).toBe('idle')
    expect(sink.state.syncWarning).toBeNull()
  })

  it('handles leaderConflict events', () => {
    processor.handleSyncEvent({ type: 'leaderConflict', hasConflict: true })
    expect(sink.state.isLeaderConflict).toBe(true)

    processor.handleSyncEvent({ type: 'leaderConflict', hasConflict: false })
    expect(sink.state.isLeaderConflict).toBe(false)
  })

  it('manages recovery entries and subscriber notifications', () => {
    const listener = vi.fn()
    const unsubscribe = processor.subscribeRecoveryItems(listener)

    // Initial subscribe invokes immediately with current entries
    expect(listener).toHaveBeenCalledWith([])

    const mockEntries: ManualRecoveryEntry[] = [
      { id: 'r1', itemId: 'item-1' as ItemId, reason: 'error', kind: 'pullDecryption', createdAt: 123 },
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

  it('delegates tokenRefreshNeeded event to callback', () => {
    const onTokenRefreshNeeded = vi.fn()
    processor.setCallbacks({ onTokenRefreshNeeded })

    processor.handleSyncEvent({ type: 'tokenRefreshNeeded' })
    expect(onTokenRefreshNeeded).toHaveBeenCalledTimes(1)
  })

  it('notifies reencryptProgress subscribers and supports unsubscription', () => {
    const progressListener = vi.fn()
    const unsubscribe = processor.subscribeReencryptProgress(progressListener)

    processor.handleSyncEvent({ type: 'reencryptProgress', done: 5, total: 20 })
    expect(progressListener).toHaveBeenCalledWith(5, 20)

    unsubscribe()
    processor.handleSyncEvent({ type: 'reencryptProgress', done: 10, total: 20 })
    expect(progressListener).toHaveBeenCalledTimes(1)
  })

  it('logs mutationFailed events with [SyncEventProcessor] tag', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    processor.handleSyncEvent({
      type: 'mutationFailed',
      mutationType: 'updateItem',
      error: 'Network timeout',
    })

    expect(errorSpy).toHaveBeenCalledWith(
      '[SyncEventProcessor] Mutation updateItem failed: Network timeout'
    )
    errorSpy.mockRestore()
  })

  it('logs reencryptProgress listener errors with [SyncEventProcessor] tag', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const throwingListener = vi.fn(() => {
      throw new Error('Listener crash')
    })
    processor.subscribeReencryptProgress(throwingListener)

    processor.handleSyncEvent({ type: 'reencryptProgress', done: 1, total: 5 })

    expect(errorSpy).toHaveBeenCalledWith(
      '[SyncEventProcessor] Error in reencryptProgress listener:',
      expect.any(Error)
    )
    errorSpy.mockRestore()
  })

  it('captures workerError events to telemetry with stack and tags', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const captureMock = telemetry.captureException

    processor.handleSyncEvent({
      type: 'workerError',
      error: {
        name: 'AutomergeWasmError',
        message: 'Out of memory during sync commit',
        stack: 'Error: Out of memory\n    at Automerge.change (automerge.wasm:1:123)',
      },
    })

    expect(captureMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'AutomergeWasmError',
        message: 'Out of memory during sync commit',
        stack: 'Error: Out of memory\n    at Automerge.change (automerge.wasm:1:123)',
      }),
      { origin: 'sync-worker' }
    )

    errorSpy.mockRestore()
  })
})

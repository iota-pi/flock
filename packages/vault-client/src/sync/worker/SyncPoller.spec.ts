import { SyncPoller } from './SyncPoller'
import { getApiAuthToken, setApiAuthToken } from '../../api/runtime'
import { SyncApiClient, AuthError } from './SyncApiClient'
import { ClientEventHub, WorkerInternalEventHub } from './SyncEventHub'
import { createMockKeyProvider, createMockVault, createTestEventHubs } from './__test__/testUtils'
import { SyncPullQueueManager } from './SyncPullQueueManager'
import { AutomergeIndexManager } from './docStore'
import { CursorStore } from './stores/CursorStore'
import type { SyncWriteAheadLog, WalEntry } from './SyncWriteAheadLog'
import { ItemId } from '@vault/shared'
import type { RecoveryManager } from './RecoveryManager'

const mockPollSyncBatch = vi.fn()
vi.mock('../../api/SyncWorkerClient', () => ({
  pollSyncBatch: (...args: any[]) => mockPollSyncBatch(...args),
}))

const encryptBytes = vi.fn().mockResolvedValue({
  iv: 'iv',
  cipher: 'cipher',
  kver: 'kver',
})
const keys = createMockKeyProvider({ ...createMockVault(), encryptBytes })


describe('SyncPoller', () => {
  let poller: SyncPoller
  let clientEventHub: ClientEventHub
  let internalEventHub: WorkerInternalEventHub
  let pullQueueManager: SyncPullQueueManager
  let indexManager: AutomergeIndexManager
  let mockWal: SyncWriteAheadLog
  let mockRecoveryManager: RecoveryManager

  beforeEach(() => {
    vi.clearAllMocks()
    setApiAuthToken('mock-token')
    const hubs = createTestEventHubs()
    clientEventHub = hubs.clientEventHub
    internalEventHub = hubs.internalEventHub
    pullQueueManager = new SyncPullQueueManager(new CursorStore('test-account'), keys)
    indexManager = {
      updateLastSyncTime: vi.fn().mockResolvedValue(undefined),
    } as unknown as AutomergeIndexManager
    mockWal = {
      append: vi.fn().mockResolvedValue('id-1'),
      readAll: vi.fn().mockResolvedValue(new Map()),
      remove: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn().mockResolvedValue(undefined),
      markInFlight: vi.fn(),
      unmarkInFlight: vi.fn(),
    } as unknown as SyncWriteAheadLog
    mockRecoveryManager = {
      quarantine: vi.fn().mockResolvedValue(undefined),
      unquarantine: vi.fn().mockResolvedValue(undefined),
    } as unknown as RecoveryManager

    poller = new SyncPoller({
      pullQueueManager,
      clientEventHub,
      internalEventHub,
      keys,
      indexManager,
      wal: mockWal,
      recoveryManager: mockRecoveryManager,
    })
    poller.setAccount('test-account')
    poller.setOnlineState(true)
  })

  it('returns no-poll when offline or account is missing', async () => {
    poller.setOnlineState(false)
    expect(await poller.executePoll()).toBe('no-poll')

    poller.setOnlineState(true)
    poller.setAccount(null)
    expect(await poller.executePoll()).toBe('no-poll')
  })

  it('returns success on successful empty poll batch', async () => {
    mockPollSyncBatch.mockResolvedValueOnce({
      success: true,
      pushResults: [],
      pullResults: [],
    })

    const outcome = await poller.executePoll()
    expect(outcome).toBe('success')
    expect(indexManager.updateLastSyncTime).toHaveBeenCalled()
  })

  it('sends both lagging pullCursors and global clientLatestCursor in empty poll', async () => {
    vi.spyOn(pullQueueManager, 'getCursors').mockReturnValue([
      { itemId: 'item-2' as ItemId, cursor: 50 },
    ])
    vi.spyOn(pullQueueManager, 'getGlobalScanCursor').mockReturnValue(2000000)
    vi.spyOn(pullQueueManager, 'getGlobalLatestCursor').mockReturnValue(9000000)

    mockPollSyncBatch.mockResolvedValueOnce({
      success: true,
      pushResults: [],
      pullResults: [
        {
          itemId: 'item-2',
          messages: [],
          hasMore: false,
        },
        {
          itemId: 'item-1',
          messages: [],
          hasMore: false,
        },
      ],
    })

    const processPullResultsSpy = vi.spyOn(pullQueueManager, 'processPullResults').mockResolvedValueOnce(undefined as any)

    const outcome = await poller.executePoll()
    expect(outcome).toBe('success')

    expect(mockPollSyncBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        pullCursors: [{ itemId: 'item-2', cursor: 50 }],
        clientLatestCursor: 2000000,
      }),
      expect.anything()
    )

    expect(processPullResultsSpy).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ itemId: 'item-2' }),
        expect.objectContaining({ itemId: 'item-1' }),
      ])
    )
  })

  it('forwards response.hasMore to processPullResults when present', async () => {
    mockPollSyncBatch.mockResolvedValueOnce({
      success: true,
      pushResults: [],
      pullResults: [
        {
          success: true,
          itemId: 'item-1' as ItemId,
          hasMore: false,
          messages: [],
        },
      ],
      hasMore: true,
    })

    const processPullResultsSpy = vi.spyOn(pullQueueManager, 'processPullResults').mockResolvedValueOnce(undefined as any)

    const outcome = await poller.executePoll()
    expect(outcome).toBe('success')

    expect(processPullResultsSpy).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ itemId: 'item-1' }),
      ]),
      true,
      undefined,
      undefined,
    )
  })

  it('forwards response.globalNextPageToken to processPullResults when present', async () => {
    const sampleKey = 'global-page-token'
    mockPollSyncBatch.mockResolvedValueOnce({
      success: true,
      pushResults: [],
      pullResults: [
        {
          success: true,
          itemId: 'item-1' as ItemId,
          hasMore: false,
          messages: [],
        },
      ],
      hasMore: true,
      globalNextPageToken: sampleKey,
    })

    const processPullResultsSpy = vi.spyOn(pullQueueManager, 'processPullResults').mockResolvedValueOnce(undefined as any)

    const outcome = await poller.executePoll()
    expect(outcome).toBe('success')

    expect(processPullResultsSpy).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ itemId: 'item-1' }),
      ]),
      true,
      sampleKey,
      undefined,
    )
  })

  it('prefers globalHasMore over hasMore and forwards the global scan cursor', async () => {
    mockPollSyncBatch.mockResolvedValueOnce({
      success: true,
      pushResults: [],
      pullResults: [],
      hasMore: true,
      globalHasMore: false,
      globalScannedThroughCursor: 4321,
    })

    const processPullResultsSpy = vi.spyOn(pullQueueManager, 'processPullResults').mockResolvedValueOnce(undefined as any)

    await poller.executePoll()

    expect(processPullResultsSpy).toHaveBeenCalledWith([], false, undefined, 4321)
  })

  it('restarts pagination when the server rejects a page token', async () => {
    await pullQueueManager.setAccount('test-account')
    const sampleKey = 'global-page-token'
    await pullQueueManager.processPullResults([], true, sampleKey, 100)
    expect(pullQueueManager.getGlobalPageToken()).toEqual(sampleKey)

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockPollSyncBatch.mockRejectedValueOnce(
      Object.assign(new Error('bad page token'), { data: { httpStatus: 400 } }),
    )

    expect(await poller.executePoll()).toBe('failure')
    expect(mockPollSyncBatch).toHaveBeenLastCalledWith(
      expect.objectContaining({ globalPageToken: sampleKey }),
      expect.anything(),
    )
    expect(pullQueueManager.getGlobalPageToken()).toBeUndefined()

    mockPollSyncBatch.mockResolvedValueOnce({ success: true, pushResults: [], pullResults: [] })
    expect(await poller.executePoll()).toBe('success')
    expect(mockPollSyncBatch).toHaveBeenLastCalledWith(
      expect.objectContaining({ globalPageToken: undefined, clientLatestCursor: 100 }),
      expect.anything(),
    )
    errorSpy.mockRestore()
    warnSpy.mockRestore()
  })

  it('drops item page tokens when the server rejects one', async () => {
    await pullQueueManager.setAccount('test-account')
    await pullQueueManager.processPullResults([{
      success: true,
      itemId: 'item-1' as ItemId,
      hasMore: true,
      nextPageToken: 'item-page-token',
      messages: [],
    }])
    expect(pullQueueManager.getCursors()).toEqual([expect.objectContaining({ pageToken: 'item-page-token' })])

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockPollSyncBatch.mockRejectedValueOnce(
      Object.assign(new Error('bad page token'), { data: { httpStatus: 400 } }),
    )

    expect(await poller.executePoll()).toBe('failure')
    expect(pullQueueManager.getCursors()).toEqual([expect.objectContaining({ itemId: 'item-1', pageToken: undefined })])
    errorSpy.mockRestore()
    warnSpy.mockRestore()
  })

  it.each([408, 429])('keeps pagination when the server answers %i', async status => {
    await pullQueueManager.setAccount('test-account')
    await pullQueueManager.processPullResults([], true, 'global-page-token', 100)

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    mockPollSyncBatch.mockRejectedValueOnce(
      Object.assign(new Error('try again later'), { data: { httpStatus: status } }),
    )

    expect(await poller.executePoll()).toBe('failure')
    expect(pullQueueManager.getGlobalPageToken()).toEqual('global-page-token')
    errorSpy.mockRestore()
  })

  it('keeps global pagination state on transient failures', async () => {
    await pullQueueManager.setAccount('test-account')
    const sampleKey = 'global-page-token'
    await pullQueueManager.processPullResults([], true, sampleKey, 100)

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    mockPollSyncBatch.mockRejectedValueOnce(
      Object.assign(new Error('unavailable'), { data: { httpStatus: 503 } }),
    )

    expect(await poller.executePoll()).toBe('failure')
    expect(pullQueueManager.getGlobalPageToken()).toEqual(sampleKey)
    errorSpy.mockRestore()
  })

  it('sends cursors and removes sent IDs from WAL with every chunk in multi-chunk batch', async () => {
    // 6 items will produce 2 chunks of size 5 and 1
    const walMap = new Map<ItemId, WalEntry[]>()
    for (let i = 0; i < 6; i++) {
      walMap.set(`item-${i}` as ItemId, [
        { id: `msg-${i}`, itemId: `item-${i}` as ItemId, data: new Uint8Array([1, 2, 3]), createdAt: i },
      ])
    }
    vi.mocked(mockWal.readAll).mockResolvedValueOnce(walMap)

    // Add a pending item to pullQueueManager to verify cursors are populated
    pullQueueManager.addPendingItem('pending-item-1' as ItemId)

    mockPollSyncBatch
      .mockResolvedValueOnce({
        success: true,
        pushResults: [
          { itemId: 'item-0', cursor: 0 },
          { itemId: 'item-1', cursor: 1 },
          { itemId: 'item-2', cursor: 2 },
          { itemId: 'item-3', cursor: 3 },
          { itemId: 'item-4', cursor: 4 },
        ],
        pullResults: [],
      })
      .mockResolvedValueOnce({
        success: true,
        pushResults: [
          { itemId: 'item-5', cursor: 5 },
        ],
        pullResults: [],
      })

    const outcome = await poller.executePoll()
    expect(outcome).toBe('success')
    expect(mockPollSyncBatch).toHaveBeenCalledTimes(2)

    // First chunk
    expect(mockPollSyncBatch).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        pullCursors: [{ itemId: 'pending-item-1', cursor: 0 }],
        clientLatestCursor: 0,
      }),
      expect.objectContaining({
        signal: expect.any(Object),
      }),
    )

    // Second chunk - should also carry cursors
    expect(mockPollSyncBatch).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        pullCursors: [{ itemId: 'pending-item-1', cursor: 0 }],
        clientLatestCursor: 0,
      }),
      expect.objectContaining({
        signal: expect.any(Object),
      }),
    )

    // Removed sent IDs from WAL
    expect(mockWal.remove).toHaveBeenCalledTimes(2)
    expect(mockWal.remove).toHaveBeenNthCalledWith(1, ['msg-0', 'msg-1', 'msg-2', 'msg-3', 'msg-4'])
    expect(mockWal.remove).toHaveBeenNthCalledWith(2, ['msg-5'])
  })

  it('binds each pushed message to its item and sends the ciphertext format', async () => {
    vi.mocked(mockWal.readAll).mockResolvedValueOnce(new Map([
      ['item-a' as ItemId, [{ id: 'msg-a', itemId: 'item-a' as ItemId, data: new Uint8Array([1]), createdAt: 1 }]],
    ]))
    vi.mocked(encryptBytes).mockResolvedValueOnce({ iv: 'iv-a', cipher: 'cipher-a', kver: '2', format: 2 })
    mockPollSyncBatch.mockResolvedValueOnce({
      success: true,
      pushResults: [{ itemId: 'item-a', cursor: 1 }],
      pullResults: [],
    })

    await poller.executePoll()

    expect(encryptBytes).toHaveBeenCalledWith(expect.any(Uint8Array), 'item-a')
    expect(mockPollSyncBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        pushMessages: [{
          itemId: 'item-a',
          encryptedMessage: { iv: 'iv-a', cipher: 'cipher-a', kver: '2', format: 2, version: '1.0' },
        }],
      }),
      expect.anything(),
    )
  })

  describe('isAuthError classification', () => {
    it('identifies 401 and 403 httpStatus on error data as auth failure', async () => {
      mockPollSyncBatch.mockRejectedValueOnce({
        data: { httpStatus: 401 },
      })
      expect(await poller.executePoll()).toBe('auth-failure')

      mockPollSyncBatch.mockRejectedValueOnce({
        shape: { data: { httpStatus: 403 } },
      })
      expect(await poller.executePoll()).toBe('auth-failure')
    })

    it('identifies UNAUTHORIZED and FORBIDDEN error codes as auth failure', async () => {
      mockPollSyncBatch.mockRejectedValueOnce({
        data: { code: 'UNAUTHORIZED' },
      })
      expect(await poller.executePoll()).toBe('auth-failure')

      mockPollSyncBatch.mockRejectedValueOnce({
        code: 'FORBIDDEN',
      })
      expect(await poller.executePoll()).toBe('auth-failure')
    })

    it('identifies status on cause or error as auth failure', async () => {
      mockPollSyncBatch.mockRejectedValueOnce({
        cause: { status: 401 },
      })
      expect(await poller.executePoll()).toBe('auth-failure')

      mockPollSyncBatch.mockRejectedValueOnce({
        status: 403,
      })
      expect(await poller.executePoll()).toBe('auth-failure')
    })

    it('identifies UnauthorizedError / ForbiddenError names as auth failure', async () => {
      const err = new Error('Auth required')
      err.name = 'UnauthorizedError'
      mockPollSyncBatch.mockRejectedValueOnce(err)
      expect(await poller.executePoll()).toBe('auth-failure')
    })

    it('treats generic errors containing unauthorized text as regular failure if no structured auth metadata', async () => {
      mockPollSyncBatch.mockRejectedValueOnce(new Error('Network proxy error: unauthorized gateway access'))
      expect(await poller.executePoll()).toBe('failure')
    })

    it('treats standard network/generic errors as failure', async () => {
      mockPollSyncBatch.mockRejectedValueOnce(new Error('Connection timeout'))
      expect(await poller.executePoll()).toBe('failure')
    })
  })

  describe('poison pill and error isolation', () => {
    it('removes WAL items even if processPullResults throws an error', async () => {
      const walMap = new Map<ItemId, WalEntry[]>()
      walMap.set('item-1' as ItemId, [
        { id: 'msg-1', itemId: 'item-1' as ItemId, data: new Uint8Array([1, 2, 3]), createdAt: 1 },
      ])
      vi.mocked(mockWal.readAll).mockResolvedValueOnce(walMap)

      vi.spyOn(pullQueueManager, 'processPullResults').mockRejectedValueOnce(new Error('Corrupt pull batch data'))

      mockPollSyncBatch.mockResolvedValueOnce({
        success: true,
        pushResults: [{ itemId: 'item-1', cursor: 1 }],
        pullResults: [{ itemId: 'item-1', messages: [], hasMore: false }],
      })

      const outcome = await poller.executePoll()
      expect(outcome).toBe('failure')
      expect(mockWal.remove).toHaveBeenCalledWith(['msg-1'])
    })

    it('returns failure when processPullResults throws during empty poll', async () => {
      vi.spyOn(pullQueueManager, 'processPullResults').mockRejectedValueOnce(new Error('Corrupt pull batch data'))

      mockPollSyncBatch.mockResolvedValueOnce({
        success: true,
        pushResults: [],
        pullResults: [{ itemId: 'item-1', messages: [], hasMore: false }],
      })

      const outcome = await poller.executePoll()
      expect(outcome).toBe('failure')
    })
  })

  describe('shutdown and in-flight cancellation', () => {
    it('returns no-poll and skips network calls if poller is already shutdown', async () => {
      poller.shutdown()
      const outcome = await poller.executePoll()
      expect(outcome).toBe('no-poll')
      expect(mockPollSyncBatch).not.toHaveBeenCalled()
    })

    it('discards response and skips writes to WAL, cursors, and indexManager if shutdown happens while network request is in-flight', async () => {
      let resolveNetwork: (val: any) => void = () => {}
      let networkStarted = false
      mockPollSyncBatch.mockImplementationOnce(
        () =>
          new Promise(resolve => {
            networkStarted = true
            resolveNetwork = resolve
          })
      )

      const pullResultsSpy = vi.spyOn(pullQueueManager, 'processPullResults')

      const pollPromise = poller.executePoll()

      // Wait until network request has actually started
      await vi.waitFor(() => {
        expect(networkStarted).toBe(true)
      })

      // Poller is in-flight; trigger shutdown (e.g. user logout)
      poller.shutdown()

      // Network request completes after shutdown
      resolveNetwork({
        success: true,
        pushResults: [{ itemId: 'item-1', cursor: 1 }],
        pullResults: [{ itemId: 'item-1', messages: [], hasMore: false }],
      })

      const outcome = await pollPromise
      expect(outcome).toBe('no-poll')

      // Must NOT have written to stores
      expect(pullResultsSpy).not.toHaveBeenCalled()
      expect(mockWal.remove).not.toHaveBeenCalled()
      expect(indexManager.updateLastSyncTime).not.toHaveBeenCalled()
    })

    it('passes abort signal to pollSyncBatch and handles abort cleanly', async () => {
      let signalCaptured: AbortSignal | undefined
      mockPollSyncBatch.mockImplementationOnce((_input: any, options: { signal?: AbortSignal }) => {
        signalCaptured = options?.signal
        return new Promise((_, reject) => {
          options?.signal?.addEventListener('abort', () => {
            const err = new Error('AbortError')
            err.name = 'AbortError'
            reject(err)
          })
        })
      })

      const pollPromise = poller.executePoll()

      await vi.waitFor(() => {
        expect(signalCaptured).toBeDefined()
      })

      expect(signalCaptured?.aborted).toBe(false)

      poller.shutdown()
      expect(signalCaptured?.aborted).toBe(true)

      const outcome = await pollPromise
      expect(outcome).toBe('no-poll')
      expect(mockWal.remove).not.toHaveBeenCalled()
    })

    it('stops multi-chunk loop immediately if shutdown occurs after the first chunk', async () => {
      const walMap = new Map<ItemId, WalEntry[]>()
      for (let i = 0; i < 6; i++) {
        walMap.set(`item-${i}` as ItemId, [
          { id: `msg-${i}`, itemId: `item-${i}` as ItemId, data: new Uint8Array([1, 2, 3]), createdAt: i },
        ])
      }
      vi.mocked(mockWal.readAll).mockResolvedValueOnce(walMap)

      mockPollSyncBatch.mockImplementation(async () => {
        // Shut down poller during chunk 1 processing
        poller.shutdown()
        return {
          success: true,
          pushResults: [],
          pullResults: [],
        }
      })

      const outcome = await poller.executePoll()
      expect(outcome).toBe('no-poll')

      // Only chunk 1 was attempted; chunk 2 was aborted/skipped
      expect(mockPollSyncBatch).toHaveBeenCalledTimes(1)
      // WAL removal should have been suppressed because of shutdown
      expect(mockWal.remove).not.toHaveBeenCalled()
    })

    it('resets isShutdown when setAccount is called with valid account', async () => {
      poller.shutdown()
      expect(await poller.executePoll()).toBe('no-poll')

      poller.setAccount('new-account')
      mockPollSyncBatch.mockResolvedValueOnce({
        success: true,
        pushResults: [],
        pullResults: [],
      })

      expect(await poller.executePoll()).toBe('success')
    })

    it('abort() cancels in-flight poll cleanly without permanently disabling future polls', async () => {
      let signalCaptured: AbortSignal | undefined
      mockPollSyncBatch.mockImplementationOnce((_input: any, options: { signal?: AbortSignal }) => {
        signalCaptured = options?.signal
        return new Promise((_, reject) => {
          options?.signal?.addEventListener('abort', () => {
            const err = new Error('AbortError')
            err.name = 'AbortError'
            reject(err)
          })
        })
      })

      const pollPromise = poller.executePoll()

      await vi.waitFor(() => {
        expect(signalCaptured).toBeDefined()
      })

      expect(signalCaptured?.aborted).toBe(false)

      poller.abort()
      expect(signalCaptured?.aborted).toBe(true)

      const outcome = await pollPromise
      expect(outcome).toBe('no-poll')

      // Subsequent executePoll should succeed without calling setAccount
      mockPollSyncBatch.mockResolvedValueOnce({
        success: true,
        pushResults: [],
        pullResults: [],
      })

      const nextOutcome = await poller.executePoll()
      expect(nextOutcome).toBe('success')
    })

    it('correctly tracks isCurrentlyPolling lifecycle during execution and abort', async () => {
      expect(poller.isCurrentlyPolling()).toBe(false)

      let resolveNetwork: (val: any) => void = () => {}
      let networkStarted = false
      mockPollSyncBatch.mockImplementationOnce(
        () =>
          new Promise(resolve => {
            networkStarted = true
            resolveNetwork = resolve
          })
      )

      const pollPromise = poller.executePoll()
      await vi.waitFor(() => {
        expect(networkStarted).toBe(true)
      })
      expect(poller.isCurrentlyPolling()).toBe(true)

      resolveNetwork({
        success: true,
        pushResults: [],
        pullResults: [],
      })
      await pollPromise
      expect(poller.isCurrentlyPolling()).toBe(false)
    })

    it('checkAlive aborts poll before network dispatch if poller goes offline during preparation', async () => {
      // Mock packBatchedMessages / encryptBytes to take time or trigger offline before network call
      poller.setOnlineState(false)
      const outcome = await poller.executePoll()
      expect(outcome).toBe('no-poll')
      expect(mockPollSyncBatch).not.toHaveBeenCalled()
    })
  })

  describe('pushResults inspection and selective WAL removal', () => {
    it('removes only WAL entries for items explicitly acknowledged as successful when some items fail', async () => {
      const walMap = new Map<ItemId, WalEntry[]>()
      walMap.set('item-1' as ItemId, [
        { id: 'msg-1', itemId: 'item-1' as ItemId, data: new Uint8Array([1]), createdAt: 1 },
      ])
      walMap.set('item-2' as ItemId, [
        { id: 'msg-2', itemId: 'item-2' as ItemId, data: new Uint8Array([2]), createdAt: 2 },
      ])
      vi.mocked(mockWal.readAll).mockResolvedValueOnce(walMap)

      mockPollSyncBatch.mockResolvedValueOnce({
        success: true,
        pushResults: [
          { itemId: 'item-1', cursor: 10, success: true },
          { itemId: 'item-2', success: false, error: 'ConditionalCheckFailed' },
        ],
        pullResults: [],
      })

      const outcome = await poller.executePoll()
      expect(outcome).toBe('success')
      expect(mockWal.remove).toHaveBeenCalledTimes(1)
      expect(mockWal.remove).toHaveBeenCalledWith(['msg-1'])
      expect(mockWal.remove).not.toHaveBeenCalledWith(expect.arrayContaining(['msg-2']))
      expect(poller.consecutivePushFailures.get('item-2' as ItemId)).toBe(1)
      expect(poller.consecutivePushFailures.has('item-1' as ItemId)).toBe(false)
      expect(indexManager.updateLastSyncTime).toHaveBeenCalled()
    })

    it('removes only WAL entries for items present in pushResults when an item is omitted', async () => {
      const walMap = new Map<ItemId, WalEntry[]>()
      walMap.set('item-1' as ItemId, [
        { id: 'msg-1', itemId: 'item-1' as ItemId, data: new Uint8Array([1]), createdAt: 1 },
      ])
      walMap.set('item-2' as ItemId, [
        { id: 'msg-2', itemId: 'item-2' as ItemId, data: new Uint8Array([2]), createdAt: 2 },
      ])
      vi.mocked(mockWal.readAll).mockResolvedValueOnce(walMap)

      mockPollSyncBatch.mockResolvedValueOnce({
        success: true,
        pushResults: [
          { itemId: 'item-1', cursor: 10 },
        ],
        pullResults: [],
      })

      const outcome = await poller.executePoll()
      expect(outcome).toBe('success')
      expect(mockWal.remove).toHaveBeenCalledTimes(1)
      expect(mockWal.remove).toHaveBeenCalledWith(['msg-1'])
      expect(poller.consecutivePushFailures.get('item-2' as ItemId)).toBe(1)
      expect(indexManager.updateLastSyncTime).toHaveBeenCalled()
    })

    it('does not remove any WAL entries when pushResults is empty', async () => {
      const walMap = new Map<ItemId, WalEntry[]>()
      walMap.set('item-1' as ItemId, [
        { id: 'msg-1', itemId: 'item-1' as ItemId, data: new Uint8Array([1]), createdAt: 1 },
      ])
      vi.mocked(mockWal.readAll).mockResolvedValueOnce(walMap)

      mockPollSyncBatch.mockResolvedValueOnce({
        success: true,
        pushResults: [],
        pullResults: [],
      })

      const outcome = await poller.executePoll()
      expect(outcome).toBe('failure')
      expect(mockWal.remove).not.toHaveBeenCalled()
      expect(poller.consecutivePushFailures.get('item-1' as ItemId)).toBe(1)
      expect(mockWal.unmarkInFlight).toHaveBeenCalledWith(['msg-1'])
      expect(indexManager.updateLastSyncTime).not.toHaveBeenCalled()
    })

    it('removes all batched WAL entries for an acknowledged item', async () => {
      const walMap = new Map<ItemId, WalEntry[]>()
      walMap.set('item-1' as ItemId, [
        { id: 'msg-1a', itemId: 'item-1' as ItemId, data: new Uint8Array([1]), createdAt: 1 },
        { id: 'msg-1b', itemId: 'item-1' as ItemId, data: new Uint8Array([2]), createdAt: 2 },
        { id: 'msg-1c', itemId: 'item-1' as ItemId, data: new Uint8Array([3]), createdAt: 3 },
      ])
      vi.mocked(mockWal.readAll).mockResolvedValueOnce(walMap)

      mockPollSyncBatch.mockResolvedValueOnce({
        success: true,
        pushResults: [
          { itemId: 'item-1', cursor: 25 },
        ],
        pullResults: [],
      })

      const outcome = await poller.executePoll()
      expect(outcome).toBe('success')
      expect(mockWal.remove).toHaveBeenCalledWith(['msg-1a', 'msg-1b', 'msg-1c'])
      expect(poller.consecutivePushFailures.has('item-1' as ItemId)).toBe(false)
    })

    it('does not remove WAL entries when item has invalid or missing cursor without explicit success', async () => {
      const walMap = new Map<ItemId, WalEntry[]>()
      walMap.set('item-1' as ItemId, [
        { id: 'msg-1', itemId: 'item-1' as ItemId, data: new Uint8Array([1]), createdAt: 1 },
      ])
      vi.mocked(mockWal.readAll).mockResolvedValueOnce(walMap)

      mockPollSyncBatch.mockResolvedValueOnce({
        success: true,
        pushResults: [
          { itemId: 'item-1', cursor: NaN },
        ],
        pullResults: [],
      })

      const outcome = await poller.executePoll()
      expect(outcome).toBe('failure')
      expect(mockWal.remove).not.toHaveBeenCalled()
      expect(poller.consecutivePushFailures.get('item-1' as ItemId)).toBe(1)
      expect(mockWal.unmarkInFlight).toHaveBeenCalledWith(['msg-1'])
      expect(indexManager.updateLastSyncTime).not.toHaveBeenCalled()
    })

    it('removes WAL entries when pushResult has explicit success: true even without cursor', async () => {
      const walMap = new Map<ItemId, WalEntry[]>()
      walMap.set('item-1' as ItemId, [
        { id: 'msg-1', itemId: 'item-1' as ItemId, data: new Uint8Array([1]), createdAt: 1 },
      ])
      vi.mocked(mockWal.readAll).mockResolvedValueOnce(walMap)

      mockPollSyncBatch.mockResolvedValueOnce({
        success: true,
        pushResults: [
          { itemId: 'item-1', success: true },
        ],
        pullResults: [],
      })

      const outcome = await poller.executePoll()
      expect(outcome).toBe('success')
      expect(mockWal.remove).toHaveBeenCalledWith(['msg-1'])
      expect(poller.consecutivePushFailures.has('item-1' as ItemId)).toBe(false)
    })

    it('records successful push cursors as own messages before processing pull results', async () => {
      const walMap = new Map<ItemId, WalEntry[]>()
      walMap.set('item-1' as ItemId, [
        { id: 'msg-1', itemId: 'item-1' as ItemId, data: new Uint8Array([1]), createdAt: 1 },
      ])
      walMap.set('item-2' as ItemId, [
        { id: 'msg-2', itemId: 'item-2' as ItemId, data: new Uint8Array([2]), createdAt: 2 },
      ])
      vi.mocked(mockWal.readAll).mockResolvedValueOnce(walMap)

      const recordSpy = vi.spyOn(pullQueueManager, 'recordOwnPushedMessage')
      const processPullResultsSpy = vi.spyOn(pullQueueManager, 'processPullResults').mockResolvedValueOnce(undefined as any)

      mockPollSyncBatch.mockResolvedValueOnce({
        success: true,
        pushResults: [
          { itemId: 'item-1', cursor: 123, success: true },
          { itemId: 'item-2', success: false, error: 'DatabaseWriteFailed' },
        ],
        pullResults: [],
      })

      await poller.executePoll()

      expect(recordSpy).toHaveBeenCalledTimes(1)
      expect(recordSpy).toHaveBeenCalledWith('item-1', 123)
      expect(recordSpy.mock.invocationCallOrder[0]).toBeLessThan(processPullResultsSpy.mock.invocationCallOrder[0])
    })

    it('processes pullResults without backoff on partial push failure in multi-item chunk (Option B)', async () => {
      const walMap = new Map<ItemId, WalEntry[]>()
      walMap.set('item-1' as ItemId, [
        { id: 'msg-1', itemId: 'item-1' as ItemId, data: new Uint8Array([1]), createdAt: 1 },
      ])
      walMap.set('item-2' as ItemId, [
        { id: 'msg-2', itemId: 'item-2' as ItemId, data: new Uint8Array([2]), createdAt: 2 },
      ])
      vi.mocked(mockWal.readAll).mockResolvedValueOnce(walMap)

      const processPullResultsSpy = vi.spyOn(pullQueueManager, 'processPullResults').mockResolvedValueOnce(undefined as any)

      mockPollSyncBatch.mockResolvedValueOnce({
        success: true,
        pushResults: [
          { itemId: 'item-1', cursor: 10, success: true },
          { itemId: 'item-2', success: false, error: 'DatabaseWriteFailed' },
        ],
        pullResults: [
          {
            itemId: 'item-pull-1',
            messages: [],
            hasMore: false,
          },
        ],
      })

      const outcome = await poller.executePoll()
      // Partial success returns 'success' so healthy items and pulls are not blocked
      expect(outcome).toBe('success')

      // Acknowledged item is removed from WAL
      expect(mockWal.remove).toHaveBeenCalledWith(['msg-1'])
      expect(mockWal.remove).not.toHaveBeenCalledWith(expect.arrayContaining(['msg-2']))

      // Pull results from this batch are still processed
      expect(processPullResultsSpy).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ itemId: 'item-pull-1' }),
        ])
      )

      // Item 2 failure count incremented
      expect(poller.consecutivePushFailures.get('item-2' as ItemId)).toBe(1)
      expect(indexManager.updateLastSyncTime).toHaveBeenCalled()
    })

    it('quarantines item and removes from WAL after reaching MAX_CONSECUTIVE_PUSH_FAILURES', async () => {
      const itemId = 'item-bad' as ItemId
      const walMap = new Map<ItemId, WalEntry[]>()
      walMap.set(itemId, [
        { id: 'msg-bad', itemId, data: new Uint8Array([99]), createdAt: 1 },
      ])
      vi.mocked(mockWal.readAll).mockResolvedValue(walMap)

      // Pre-seed with 4 failures
      poller.consecutivePushFailures.set(itemId, 4)

      mockPollSyncBatch.mockResolvedValueOnce({
        success: true,
        pushResults: [
          { itemId, success: false, error: 'PayloadTooLarge' },
        ],
        pullResults: [],
      })

      const outcome = await poller.executePoll()
      // Quarantined items are cleared from WAL and considered handled (returns 'success')
      expect(outcome).toBe('success')

      // Recovery manager was asked to quarantine the item
      expect(mockRecoveryManager.quarantine).toHaveBeenCalledWith(
        itemId,
        'pushFailure',
        expect.stringContaining('Push failed after 5 consecutive attempts: PayloadTooLarge')
      )

      // Quarantined item's entries are removed from WAL
      expect(mockWal.remove).toHaveBeenCalledWith(['msg-bad'])

      // Failure count cleared after quarantine
      expect(poller.consecutivePushFailures.has(itemId)).toBe(false)
    })

    it('resets consecutivePushFailures when item subsequently succeeds', async () => {
      const itemId = 'item-flaky' as ItemId
      const walMap = new Map<ItemId, WalEntry[]>()
      walMap.set(itemId, [
        { id: 'msg-flaky', itemId, data: new Uint8Array([50]), createdAt: 1 },
      ])
      vi.mocked(mockWal.readAll).mockResolvedValue(walMap)

      // Pre-seed with 3 failures
      poller.consecutivePushFailures.set(itemId, 3)

      mockPollSyncBatch.mockResolvedValueOnce({
        success: true,
        pushResults: [
          { itemId, cursor: 50, success: true },
        ],
        pullResults: [],
      })

      const outcome = await poller.executePoll()
      expect(outcome).toBe('success')
      expect(mockWal.remove).toHaveBeenCalledWith(['msg-flaky'])
      expect(poller.consecutivePushFailures.has(itemId)).toBe(false)
      expect(mockRecoveryManager.quarantine).not.toHaveBeenCalled()
    })

    it('returns failure when wal.remove throws during push acknowledgment', async () => {
      const walMap = new Map<ItemId, WalEntry[]>()
      walMap.set('item-1' as ItemId, [
        { id: 'msg-1', itemId: 'item-1' as ItemId, data: new Uint8Array([1]), createdAt: 1 },
      ])
      vi.mocked(mockWal.readAll).mockResolvedValueOnce(walMap)
      vi.mocked(mockWal.remove).mockRejectedValueOnce(new Error('IndexedDB transaction failed'))

      mockPollSyncBatch.mockResolvedValueOnce({
        success: true,
        pushResults: [
          { itemId: 'item-1', success: true },
        ],
        pullResults: [],
      })

      const outcome = await poller.executePoll()
      expect(outcome).toBe('failure')
      expect(mockWal.unmarkInFlight).toHaveBeenCalledWith(['msg-1'])
    })
  })

  describe('Auth and SyncApiClient integration', () => {
    it('returns auth-failure when apiClient reports no auth token', async () => {
      const mockApiClient = {
        pollSyncBatch: vi.fn().mockRejectedValue(new AuthError('No active session token available')),
      } as unknown as SyncApiClient

      const authPoller = new SyncPoller({
        pullQueueManager,
        clientEventHub,
        internalEventHub,
        keys,
        indexManager,
        wal: mockWal,
        apiClient: mockApiClient,
      })
      authPoller.setAccount('test-account')
      authPoller.setOnlineState(true)

      const outcome = await authPoller.executePoll()
      expect(outcome).toBe('auth-failure')
      expect(mockApiClient.pollSyncBatch).toHaveBeenCalled()
    })

    it('recovers transparently and succeeds when initial poll fails with 401 but refresh succeeds', async () => {
      const refreshAuthToken = vi.fn().mockImplementation(async () => {
        setApiAuthToken('refreshed-session-token')
        return 'refreshed-session-token'
      })
      const apiClient = new SyncApiClient({ refreshAuthToken })

      const tokensSent: string[] = []
      mockPollSyncBatch
        .mockImplementationOnce(async () => {
          tokensSent.push(getApiAuthToken())
          throw { httpStatus: 401, message: 'Session expired' }
        })
        .mockImplementationOnce(async () => {
          tokensSent.push(getApiAuthToken())
          return {
            success: true,
            pushResults: [],
            pullResults: [],
          }
        })

      const authPoller = new SyncPoller({
        pullQueueManager,
        clientEventHub,
        internalEventHub,
        keys,
        indexManager,
        wal: mockWal,
        apiClient: apiClient,
      })
      authPoller.setAccount('test-account')
      authPoller.setOnlineState(true)

      const outcome = await authPoller.executePoll()
      expect(outcome).toBe('success')
      expect(refreshAuthToken).toHaveBeenCalledTimes(1)
      expect(mockPollSyncBatch).toHaveBeenCalledTimes(2)
      expect(tokensSent).toEqual(['mock-token', 'refreshed-session-token'])
    })

    it('returns auth-failure when poll fails with 401 and token cannot be refreshed', async () => {
      const refreshAuthToken = vi.fn().mockResolvedValue(null)
      const apiClient = new SyncApiClient({ refreshAuthToken })

      mockPollSyncBatch.mockRejectedValue({ httpStatus: 401, message: 'Unauthorized' })

      const authPoller = new SyncPoller({
        pullQueueManager,
        clientEventHub,
        internalEventHub,
        keys,
        indexManager,
        wal: mockWal,
        apiClient: apiClient,
      })
      authPoller.setAccount('test-account')
      authPoller.setOnlineState(true)

      const outcome = await authPoller.executePoll()
      expect(outcome).toBe('auth-failure')
      expect(refreshAuthToken).toHaveBeenCalledTimes(1)
    })
  })
})

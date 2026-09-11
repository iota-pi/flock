import { SyncPoller } from './SyncPoller'
import { ClientEventHub, WorkerInternalEventHub } from './SyncEventHub'
import { SyncPullQueueManager } from './SyncPullQueueManager'
import { AutomergeIndexManager } from './docStore/AutomergeIndexManager'
import { CursorStore } from './stores/CursorStore'
import type { SyncWriteAheadLog, WalEntry } from './SyncWriteAheadLog'
import { ItemId } from 'src/shared/schemas/items'

const mockPollSyncBatchWithToken = vi.fn()
vi.mock('../../api/vault/SyncWorkerClient', () => ({
  pollSyncBatchWithToken: (...args: any[]) => mockPollSyncBatchWithToken(...args),
}))

vi.mock('../../api/vault', () => ({
  encryptBytes: vi.fn().mockResolvedValue({
    iv: 'iv',
    cipher: 'cipher',
    kver: 'kver',
  }),
}))

vi.mock('../shared/workerAuthStore', () => ({
  getActiveSessionToken: vi.fn().mockResolvedValue('mock-token'),
}))

describe('SyncPoller', () => {
  let poller: SyncPoller
  let clientEventHub: ClientEventHub
  let internalEventHub: WorkerInternalEventHub
  let pullQueueManager: SyncPullQueueManager
  let indexManager: AutomergeIndexManager
  let mockWal: SyncWriteAheadLog

  beforeEach(() => {
    vi.clearAllMocks()
    clientEventHub = new ClientEventHub()
    internalEventHub = new WorkerInternalEventHub()
    pullQueueManager = new SyncPullQueueManager(new CursorStore('test-account'))
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

    poller = new SyncPoller(
      pullQueueManager,
      clientEventHub,
      internalEventHub,
      indexManager,
      mockWal,
    )
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
    mockPollSyncBatchWithToken.mockResolvedValueOnce({
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
    vi.spyOn(pullQueueManager, 'getGlobalLatestCursor').mockReturnValue(2000000)

    mockPollSyncBatchWithToken.mockResolvedValueOnce({
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

    expect(mockPollSyncBatchWithToken).toHaveBeenCalledWith(
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
    mockPollSyncBatchWithToken.mockResolvedValueOnce({
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
      undefined
    )
  })

  it('forwards response.globalLastEvaluatedKey to processPullResults when present', async () => {
    const sampleKey = { account: 'test-account', cursor: 12345, syncId: 'test-account#item-1' }
    mockPollSyncBatchWithToken.mockResolvedValueOnce({
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
      globalLastEvaluatedKey: sampleKey,
    })

    const processPullResultsSpy = vi.spyOn(pullQueueManager, 'processPullResults').mockResolvedValueOnce(undefined as any)

    const outcome = await poller.executePoll()
    expect(outcome).toBe('success')

    expect(processPullResultsSpy).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ itemId: 'item-1' }),
      ]),
      true,
      sampleKey
    )
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

    mockPollSyncBatchWithToken
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
    expect(mockPollSyncBatchWithToken).toHaveBeenCalledTimes(2)

    // First chunk
    expect(mockPollSyncBatchWithToken).toHaveBeenNthCalledWith(
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
    expect(mockPollSyncBatchWithToken).toHaveBeenNthCalledWith(
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

  describe('isAuthError classification', () => {
    it('identifies 401 and 403 httpStatus on error data as auth failure', async () => {
      mockPollSyncBatchWithToken.mockRejectedValueOnce({
        data: { httpStatus: 401 },
      })
      expect(await poller.executePoll()).toBe('auth-failure')

      mockPollSyncBatchWithToken.mockRejectedValueOnce({
        shape: { data: { httpStatus: 403 } },
      })
      expect(await poller.executePoll()).toBe('auth-failure')
    })

    it('identifies UNAUTHORIZED and FORBIDDEN error codes as auth failure', async () => {
      mockPollSyncBatchWithToken.mockRejectedValueOnce({
        data: { code: 'UNAUTHORIZED' },
      })
      expect(await poller.executePoll()).toBe('auth-failure')

      mockPollSyncBatchWithToken.mockRejectedValueOnce({
        code: 'FORBIDDEN',
      })
      expect(await poller.executePoll()).toBe('auth-failure')
    })

    it('identifies status on cause or error as auth failure', async () => {
      mockPollSyncBatchWithToken.mockRejectedValueOnce({
        cause: { status: 401 },
      })
      expect(await poller.executePoll()).toBe('auth-failure')

      mockPollSyncBatchWithToken.mockRejectedValueOnce({
        status: 403,
      })
      expect(await poller.executePoll()).toBe('auth-failure')
    })

    it('identifies UnauthorizedError / ForbiddenError names as auth failure', async () => {
      const err = new Error('Auth required')
      err.name = 'UnauthorizedError'
      mockPollSyncBatchWithToken.mockRejectedValueOnce(err)
      expect(await poller.executePoll()).toBe('auth-failure')
    })

    it('treats generic errors containing unauthorized text as regular failure if no structured auth metadata', async () => {
      mockPollSyncBatchWithToken.mockRejectedValueOnce(new Error('Network proxy error: unauthorized gateway access'))
      expect(await poller.executePoll()).toBe('failure')
    })

    it('treats standard network/generic errors as failure', async () => {
      mockPollSyncBatchWithToken.mockRejectedValueOnce(new Error('Connection timeout'))
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

      mockPollSyncBatchWithToken.mockResolvedValueOnce({
        success: true,
        pushResults: [{ itemId: 'item-1', cursor: 1 }],
        pullResults: [{ itemId: 'item-1', messages: [], hasMore: false }],
      })

      const outcome = await poller.executePoll()
      expect(outcome).toBe('success')
      expect(mockWal.remove).toHaveBeenCalledWith(['msg-1'])
    })

    it('does not fail empty poll when processPullResults throws', async () => {
      vi.spyOn(pullQueueManager, 'processPullResults').mockRejectedValueOnce(new Error('Corrupt pull batch data'))

      mockPollSyncBatchWithToken.mockResolvedValueOnce({
        success: true,
        pushResults: [],
        pullResults: [{ itemId: 'item-1', messages: [], hasMore: false }],
      })

      const outcome = await poller.executePoll()
      expect(outcome).toBe('success')
    })
  })

  describe('shutdown and in-flight cancellation', () => {
    it('returns no-poll and skips network calls if poller is already shutdown', async () => {
      poller.shutdown()
      const outcome = await poller.executePoll()
      expect(outcome).toBe('no-poll')
      expect(mockPollSyncBatchWithToken).not.toHaveBeenCalled()
    })

    it('discards response and skips writes to WAL, cursors, and indexManager if shutdown happens while network request is in-flight', async () => {
      let resolveNetwork: (val: any) => void = () => {}
      let networkStarted = false
      mockPollSyncBatchWithToken.mockImplementationOnce(
        () =>
          new Promise(resolve => {
            networkStarted = true
            resolveNetwork = resolve
          })
      )

      const pushResultsSpy = vi.spyOn(pullQueueManager, 'processPushResults')
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
      expect(pushResultsSpy).not.toHaveBeenCalled()
      expect(pullResultsSpy).not.toHaveBeenCalled()
      expect(mockWal.remove).not.toHaveBeenCalled()
      expect(indexManager.updateLastSyncTime).not.toHaveBeenCalled()
    })

    it('passes abort signal to pollSyncBatchWithToken and handles abort cleanly', async () => {
      let signalCaptured: AbortSignal | undefined
      mockPollSyncBatchWithToken.mockImplementationOnce((_input: any, options: { signal?: AbortSignal }) => {
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

      mockPollSyncBatchWithToken.mockImplementation(async () => {
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
      expect(mockPollSyncBatchWithToken).toHaveBeenCalledTimes(1)
      // WAL removal should have been suppressed because of shutdown
      expect(mockWal.remove).not.toHaveBeenCalled()
    })

    it('resets isShutdown when setAccount is called with valid account', async () => {
      poller.shutdown()
      expect(await poller.executePoll()).toBe('no-poll')

      poller.setAccount('new-account')
      mockPollSyncBatchWithToken.mockResolvedValueOnce({
        success: true,
        pushResults: [],
        pullResults: [],
      })

      expect(await poller.executePoll()).toBe('success')
    })

    it('abort() cancels in-flight poll cleanly without permanently disabling future polls', async () => {
      let signalCaptured: AbortSignal | undefined
      mockPollSyncBatchWithToken.mockImplementationOnce((_input: any, options: { signal?: AbortSignal }) => {
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
      mockPollSyncBatchWithToken.mockResolvedValueOnce({
        success: true,
        pushResults: [],
        pullResults: [],
      })

      const nextOutcome = await poller.executePoll()
      expect(nextOutcome).toBe('success')
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

      mockPollSyncBatchWithToken.mockResolvedValueOnce({
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

      mockPollSyncBatchWithToken.mockResolvedValueOnce({
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
    })

    it('does not remove any WAL entries when pushResults is empty', async () => {
      const walMap = new Map<ItemId, WalEntry[]>()
      walMap.set('item-1' as ItemId, [
        { id: 'msg-1', itemId: 'item-1' as ItemId, data: new Uint8Array([1]), createdAt: 1 },
      ])
      vi.mocked(mockWal.readAll).mockResolvedValueOnce(walMap)

      mockPollSyncBatchWithToken.mockResolvedValueOnce({
        success: true,
        pushResults: [],
        pullResults: [],
      })

      const outcome = await poller.executePoll()
      expect(outcome).toBe('success')
      expect(mockWal.remove).not.toHaveBeenCalled()
    })

    it('removes all batched WAL entries for an acknowledged item', async () => {
      const walMap = new Map<ItemId, WalEntry[]>()
      walMap.set('item-1' as ItemId, [
        { id: 'msg-1a', itemId: 'item-1' as ItemId, data: new Uint8Array([1]), createdAt: 1 },
        { id: 'msg-1b', itemId: 'item-1' as ItemId, data: new Uint8Array([2]), createdAt: 2 },
        { id: 'msg-1c', itemId: 'item-1' as ItemId, data: new Uint8Array([3]), createdAt: 3 },
      ])
      vi.mocked(mockWal.readAll).mockResolvedValueOnce(walMap)

      mockPollSyncBatchWithToken.mockResolvedValueOnce({
        success: true,
        pushResults: [
          { itemId: 'item-1', cursor: 25 },
        ],
        pullResults: [],
      })

      const outcome = await poller.executePoll()
      expect(outcome).toBe('success')
      expect(mockWal.remove).toHaveBeenCalledWith(['msg-1a', 'msg-1b', 'msg-1c'])
    })

    it('does not remove WAL entries when item has invalid or missing cursor without explicit success', async () => {
      const walMap = new Map<ItemId, WalEntry[]>()
      walMap.set('item-1' as ItemId, [
        { id: 'msg-1', itemId: 'item-1' as ItemId, data: new Uint8Array([1]), createdAt: 1 },
      ])
      vi.mocked(mockWal.readAll).mockResolvedValueOnce(walMap)

      mockPollSyncBatchWithToken.mockResolvedValueOnce({
        success: true,
        pushResults: [
          { itemId: 'item-1', cursor: NaN },
        ],
        pullResults: [],
      })

      const outcome = await poller.executePoll()
      expect(outcome).toBe('success')
      expect(mockWal.remove).not.toHaveBeenCalled()
    })

    it('removes WAL entries when pushResult has explicit success: true even without cursor', async () => {
      const walMap = new Map<ItemId, WalEntry[]>()
      walMap.set('item-1' as ItemId, [
        { id: 'msg-1', itemId: 'item-1' as ItemId, data: new Uint8Array([1]), createdAt: 1 },
      ])
      vi.mocked(mockWal.readAll).mockResolvedValueOnce(walMap)

      mockPollSyncBatchWithToken.mockResolvedValueOnce({
        success: true,
        pushResults: [
          { itemId: 'item-1', success: true },
        ],
        pullResults: [],
      })

      const outcome = await poller.executePoll()
      expect(outcome).toBe('success')
      expect(mockWal.remove).toHaveBeenCalledWith(['msg-1'])
    })
  })
})


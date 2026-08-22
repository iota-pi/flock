import { SyncPoller } from './SyncPoller'
import { ClientEventHub, WorkerInternalEventHub } from './SyncEventHub'
import { SyncPullQueueManager } from './SyncPullQueueManager'
import { AutomergeIndexManager } from './docStore/AutomergeIndexManager'
import { CursorStore } from './stores/CursorStore'

import { loadSyncBatch } from '../shared/VaultPersistence'
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

vi.mock('../shared/VaultPersistence', () => ({
  loadSyncBatch: vi.fn().mockResolvedValue([]),
  removeSentSyncMessages: vi.fn().mockResolvedValue(undefined),
}))

describe('SyncPoller', () => {
  let poller: SyncPoller
  let clientEventHub: ClientEventHub
  let internalEventHub: WorkerInternalEventHub
  let pullQueueManager: SyncPullQueueManager
  let indexManager: AutomergeIndexManager

  beforeEach(() => {
    vi.clearAllMocks()
    clientEventHub = new ClientEventHub()
    internalEventHub = new WorkerInternalEventHub()
    pullQueueManager = new SyncPullQueueManager(new CursorStore('test-account'))
    indexManager = {
      updateLastSyncTime: vi.fn().mockResolvedValue(undefined),
    } as unknown as AutomergeIndexManager

    poller = new SyncPoller(
      pullQueueManager,
      clientEventHub,
      internalEventHub,
      indexManager,
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

  it('sends cursors with every chunk in multi-chunk batch', async () => {
    // 6 items will produce 2 chunks of size 5 and 1
    const mockBatch: [ItemId, Uint8Array[]][] = Array.from({ length: 6 }, (_, i) => [
      `item-${i}` as ItemId,
      [new Uint8Array([1, 2, 3])],
    ])
    vi.mocked(loadSyncBatch).mockResolvedValueOnce(mockBatch)

    // Add a pending item to pullQueueManager to verify cursors are populated
    pullQueueManager.addPendingItem('pending-item-1' as ItemId)

    mockPollSyncBatchWithToken
      .mockResolvedValueOnce({
        success: true,
        pushResults: [],
        pullResults: [],
      })
      .mockResolvedValueOnce({
        success: true,
        pushResults: [],
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
    )

    // Second chunk - should also carry cursors
    expect(mockPollSyncBatchWithToken).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        pullCursors: [{ itemId: 'pending-item-1', cursor: 0 }],
        clientLatestCursor: 0,
      }),
    )
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
})

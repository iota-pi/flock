import type { Mock } from 'vitest'
import type { ItemId, SyncLogMessage } from '@vault/shared'
import { LogExchange, type LogExchangeDeps } from './LogExchange'
import { SyncPoller, type SyncPollerDeps } from './SyncPoller'
import { SyncSessionState } from './SyncSessionState'
import { AuthError } from './SyncApiClient'

type AnyMock = Mock<(...args: any[]) => any>

const ITEM = 'item-1' as ItemId
const MESSAGE: SyncLogMessage = { itemId: ITEM, encryptedMessage: { iv: 'iv', cipher: 'cipher', kver: '1' } }

const FETCHED = { added: [], success: true, fetchedManifest: true }
const NOT_FETCHED = { added: [], success: false, fetchedManifest: false }

function response(overrides: Record<string, unknown> = {}) {
  return { pushResults: [], entries: [], hasMore: false, serverNow: 1000, ...overrides }
}

describe('SyncPoller', () => {
  let session: SyncSessionState
  let puller: {
    cursor: number
    recordOwnPushes: AnyMock
    needsCatchUpManifest: AnyMock
    onBehindSeen: AnyMock
    onCatchUpManifestSynced: AnyMock
    onRecoveryManifestSynced: AnyMock
    pendingManifestSync: 'catchUp' | 'recovery' | undefined
    process: AnyMock
  }
  let outbox: { pushPending: AnyMock }
  let healer: { runDue: AnyMock }
  let apiClient: { pollLog: AnyMock }
  let runManifestPhase: AnyMock
  let snapshots: { pushDue: AnyMock }
  let exchange: LogExchange
  let poller: SyncPoller

  /** Manifest syncs asked for at once (catch-up or recovery), rather than the periodic phase */
  const manifestSyncsNow = () => runManifestPhase.mock.calls.filter(([, minMode]) => minMode === 'now').length

  beforeEach(() => {
    session = new SyncSessionState({ isLeader: true })
    puller = {
      cursor: 7,
      recordOwnPushes: vi.fn(),
      needsCatchUpManifest: vi.fn().mockReturnValue(false),
      onBehindSeen: vi.fn(() => { puller.pendingManifestSync = 'catchUp' }),
      onCatchUpManifestSynced: vi.fn(() => { puller.pendingManifestSync = undefined }),
      onRecoveryManifestSynced: vi.fn(() => { puller.pendingManifestSync = undefined }),
      pendingManifestSync: undefined,
      process: vi.fn().mockResolvedValue(undefined),
    }
    outbox = { pushPending: vi.fn().mockResolvedValue(undefined) }
    healer = { runDue: vi.fn().mockResolvedValue(undefined) }
    apiClient = { pollLog: vi.fn().mockResolvedValue(response()) }
    // Runs only when asked for one, as catch-up and recovery do
    runManifestPhase = vi.fn(async (_signal: AbortSignal, minMode?: string) => (minMode ? FETCHED : null))
    snapshots = { pushDue: vi.fn().mockResolvedValue({ persisted: 0, total: 0, success: true }) }
    exchange = new LogExchange({
      accountId: 'account-1',
      session,
      puller: puller as unknown as LogExchangeDeps['puller'],
      apiClient,
    })
    poller = new SyncPoller({
      session,
      puller: puller as unknown as SyncPollerDeps['puller'],
      exchange,
      outbox,
      healer,
      runManifestPhase,
      snapshots,
    })
  })

  it('does nothing unless the session may sync', async () => {
    session.setOnline(false)

    expect(await poller.executePoll()).toBe('no-poll')
    expect(apiClient.pollLog).not.toHaveBeenCalled()
  })

  it('pushes, reads the log after the cursor, runs the manifest phase, heals, then uploads snapshots', async () => {
    const order: string[] = []
    outbox.pushPending.mockImplementation(async () => { order.push('push') })
    apiClient.pollLog.mockImplementation(async () => {
      order.push('pollLog')
      return response()
    })
    runManifestPhase.mockImplementation(async () => {
      order.push('manifest')
      return null
    })
    healer.runDue.mockImplementation(async () => { order.push('heal') })
    snapshots.pushDue.mockImplementation(async () => { order.push('snapshots') })

    expect(await poller.executePoll()).toBe('success')

    expect(order).toEqual(['push', 'pollLog', 'manifest', 'heal', 'snapshots'])
    expect(apiClient.pollLog).toHaveBeenCalledWith(
      { account: 'account-1', push: [], after: 7 },
      { signal: expect.any(AbortSignal) },
    )
  })

  it('uploads snapshots with the poll\'s signal, so aborting the poll aborts them', async () => {
    const controller = new AbortController()

    await poller.executePoll(controller.signal)

    expect(snapshots.pushDue).toHaveBeenCalledWith(controller.signal)
  })

  it('runs the manifest phase with the poll\'s signal, so aborting the poll aborts it', async () => {
    const controller = new AbortController()

    await poller.executePoll(controller.signal)

    expect(runManifestPhase).toHaveBeenCalledWith(controller.signal)
  })

  // Rule 4: reporting success would reset backoff
  it('fails the poll, without uploading snapshots, when the manifest phase throws', async () => {
    runManifestPhase.mockRejectedValue(new Error('Network down'))

    expect(await poller.executePoll()).toBe('failure')

    expect(snapshots.pushDue).not.toHaveBeenCalled()
  })

  it('reports an expired session from the manifest phase as an auth failure', async () => {
    runManifestPhase.mockRejectedValue(new AuthError('expired'))

    expect(await poller.executePoll()).toBe('auth-failure')
  })

  it('reads the log only once when a push already did', async () => {
    outbox.pushPending.mockImplementation(() => exchange.exchange([MESSAGE], async () => {}))

    await poller.executePoll()

    expect(apiClient.pollLog).toHaveBeenCalledTimes(1)
    expect(puller.process).toHaveBeenCalledTimes(1)
  })

  describe('rule 4: a poll reports failure if anything threw', () => {
    it.each([
      ['the push', () => outbox.pushPending],
      ['the request', () => apiClient.pollLog],
      ['processing the page', () => puller.process],
      ['healing', () => healer.runDue],
      ['uploading snapshots', () => snapshots.pushDue],
    ])('%s failing', async (_name, getStep) => {
      getStep().mockRejectedValue(new Error('failed'))

      expect(await poller.executePoll()).toBe('failure')
    })

    it('reports an auth failure apart', async () => {
      apiClient.pollLog.mockRejectedValue({ data: { httpStatus: 401, code: 'UNAUTHORIZED' }, message: 'UNAUTHORIZED' })

      expect(await poller.executePoll()).toBe('auth-failure')
    })

    // So an expired session pauses snapshot uploads with polling, rather than leaving them to retry alone
    it('reports an auth failure while uploading snapshots apart', async () => {
      snapshots.pushDue.mockRejectedValue({ data: { httpStatus: 401, code: 'UNAUTHORIZED' }, message: 'UNAUTHORIZED' })

      expect(await poller.executePoll()).toBe('auth-failure')
    })

    it('reports an aborted poll as no poll', async () => {
      const controller = new AbortController()
      controller.abort()

      expect(await poller.executePoll(controller.signal)).toBe('no-poll')
    })
  })

  describe('catching up', () => {
    it('runs a manifest sync before reading the log', async () => {
      puller.needsCatchUpManifest.mockReturnValueOnce(true)
      const order: string[] = []
      runManifestPhase.mockImplementation(async (_signal: AbortSignal, minMode?: string) => {
        if (!minMode) return null
        order.push('manifest')
        return FETCHED
      })
      apiClient.pollLog.mockImplementation(async () => {
        order.push('pollLog')
        return response()
      })

      await poller.executePoll()

      expect(order).toEqual(['manifest', 'pollLog'])
      expect(puller.onCatchUpManifestSynced).toHaveBeenCalledTimes(1)
    })

    it('fails the poll when the manifest can\'t be fetched', async () => {
      puller.needsCatchUpManifest.mockReturnValueOnce(true)
      runManifestPhase.mockResolvedValue(NOT_FETCHED)

      expect(await poller.executePoll()).toBe('failure')
      expect(apiClient.pollLog).not.toHaveBeenCalled()
    })

    it('drops a page when the server clock shows the device is behind, and reads it again after catching up', async () => {
      puller.needsCatchUpManifest.mockReturnValueOnce(false).mockReturnValueOnce(true)

      expect(await poller.executePoll()).toBe('success')

      expect(puller.onBehindSeen).toHaveBeenCalledTimes(1)
      expect(manifestSyncsNow()).toBe(1)
      expect(apiClient.pollLog).toHaveBeenCalledTimes(2)
      expect(puller.process).toHaveBeenCalledTimes(1)
    })
  })

  describe('recovering lost rows', () => {
    beforeEach(() => {
      puller.process.mockImplementation(async () => { puller.pendingManifestSync = 'recovery' })
    })

    it('runs the manifest sync a lost row asked for, whatever the gap since the last one', async () => {
      expect(await poller.executePoll()).toBe('success')

      expect(manifestSyncsNow()).toBe(1)
      expect(puller.onRecoveryManifestSynced).toHaveBeenCalledTimes(1)
    })

    it('fails the poll and keeps the request when the manifest isn\'t fetched', async () => {
      runManifestPhase.mockResolvedValue(NOT_FETCHED)

      expect(await poller.executePoll()).toBe('failure')

      expect(puller.onRecoveryManifestSynced).not.toHaveBeenCalled()
      expect(puller.pendingManifestSync).toBe('recovery')
      expect(snapshots.pushDue).not.toHaveBeenCalled()
    })
  })
})

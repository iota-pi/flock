import type { Mock } from 'vitest'
import type { ItemId, SyncLogMessage } from '@vault/shared'
import { LogExchange, type LogExchangeDeps } from './LogExchange'
import { SyncPoller, type SyncPollerDeps } from './SyncPoller'
import { SyncSessionState } from './SyncSessionState'
import { AuthError } from './SyncApiClient'

type AnyMock = Mock<(...args: any[]) => any>

const ITEM = 'item-1' as ItemId
const MESSAGE: SyncLogMessage = { itemId: ITEM, encryptedMessage: { iv: 'iv', cipher: 'cipher', kver: '1' } }

function response(overrides: Record<string, unknown> = {}) {
  return { pushResults: [], entries: [], hasMore: false, serverNow: 1000, ...overrides }
}

describe('SyncPoller', () => {
  let session: SyncSessionState
  let puller: {
    cursor: number
    recordOwnPushes: AnyMock
    demandCatchUpIfBehind: AnyMock
    dropPageIfBehind: AnyMock
    process: AnyMock
  }
  let outbox: { pushPending: AnyMock }
  let healer: { runDue: AnyMock }
  let apiClient: { pollLog: AnyMock }
  let runManifestPhase: AnyMock
  let snapshots: { pushDue: AnyMock }
  let rewrites: { runDue: AnyMock; onPollStopped: AnyMock }
  let exchange: LogExchange
  let poller: SyncPoller

  beforeEach(() => {
    session = new SyncSessionState({ isLeader: true })
    puller = {
      cursor: 7,
      recordOwnPushes: vi.fn(),
      demandCatchUpIfBehind: vi.fn().mockReturnValue(false),
      dropPageIfBehind: vi.fn().mockReturnValue(false),
      process: vi.fn().mockResolvedValue(undefined),
    }
    outbox = { pushPending: vi.fn().mockResolvedValue(undefined) }
    healer = { runDue: vi.fn().mockResolvedValue(undefined) }
    apiClient = { pollLog: vi.fn().mockResolvedValue(response()) }
    runManifestPhase = vi.fn().mockResolvedValue(null)
    snapshots = { pushDue: vi.fn().mockResolvedValue({ persisted: 0, total: 0, success: true }) }
    rewrites = { runDue: vi.fn().mockResolvedValue(undefined), onPollStopped: vi.fn() }
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
      rewrites,
    })
  })

  it('does nothing unless the session may sync', async () => {
    session.setOnline(false)

    expect(await poller.executePoll()).toBe('no-poll')
    expect(apiClient.pollLog).not.toHaveBeenCalled()
  })

  it('runs a manifest phase before and after pushing and reading the log, then heals, uploads snapshots and rewrites', async () => {
    const order: string[] = []
    puller.demandCatchUpIfBehind.mockImplementation(() => { order.push('catchUp?') })
    outbox.pushPending.mockImplementation(async () => { order.push('push') })
    apiClient.pollLog.mockImplementation(async () => {
      order.push('pollLog')
      return response()
    })
    runManifestPhase.mockImplementation(async (stage: string) => {
      order.push(`manifest ${stage}`)
      return null
    })
    healer.runDue.mockImplementation(async () => { order.push('heal') })
    snapshots.pushDue.mockImplementation(async () => { order.push('snapshots') })
    rewrites.runDue.mockImplementation(async () => { order.push('rewrites') })

    expect(await poller.executePoll()).toBe('success')

    expect(order).toEqual([
      'catchUp?',
      'manifest beforeRead',
      'push',
      'pollLog',
      'manifest afterRead',
      'heal',
      'snapshots',
      'rewrites',
    ])
    expect(apiClient.pollLog).toHaveBeenCalledWith(
      { account: 'account-1', push: [], after: 7 },
      { signal: expect.any(AbortSignal) },
    )
  })

  it('uploads snapshots with the poll\'s signal, so aborting the poll aborts them', async () => {
    const controller = new AbortController()

    await poller.executePoll(controller.signal)

    expect(snapshots.pushDue).toHaveBeenCalledWith(controller.signal)
    expect(rewrites.runDue).toHaveBeenCalledWith(controller.signal)
  })

  it('runs the manifest phases with the poll signal, so aborting the poll aborts them', async () => {
    const controller = new AbortController()

    await poller.executePoll(controller.signal)

    expect(runManifestPhase.mock.calls).toEqual([['beforeRead', controller.signal], ['afterRead', controller.signal]])
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
      ['rewriting snapshots', () => rewrites.runDue],
    ])('%s failing', async (_name, getStep) => {
      getStep().mockRejectedValue(new Error('failed'))

      expect(await poller.executePoll()).toBe('failure')
    })

    it('tells the rewrite a poll failed, so its callers stop waiting', async () => {
      const error = new Error('failed')
      apiClient.pollLog.mockRejectedValue(error)

      await poller.executePoll()

      expect(rewrites.onPollStopped).toHaveBeenCalledWith(error)
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

    // So an expired session pauses rewrites with polling too
    it('reports an auth failure while rewriting snapshots apart', async () => {
      rewrites.runDue.mockRejectedValue({ data: { httpStatus: 401, code: 'UNAUTHORIZED' }, message: 'UNAUTHORIZED' })

      expect(await poller.executePoll()).toBe('auth-failure')
    })

    it('reports an aborted poll as no poll', async () => {
      const controller = new AbortController()
      controller.abort()

      expect(await poller.executePoll(controller.signal)).toBe('no-poll')
    })
  })

  describe('catching up', () => {
    it('asks the puller whether it is behind by the local clock before the first manifest phase', async () => {
      await poller.executePoll()

      expect(puller.demandCatchUpIfBehind).toHaveBeenCalledWith(expect.any(Number))
    })

    // Rule 4: a catch-up or recovery request stays until a manifest is fetched, and the poll fails
    it('fails the poll without reading the log when the manifest phase before the read throws', async () => {
      runManifestPhase.mockImplementation(async (stage: string) => {
        if (stage === 'beforeRead') throw new Error('Catching up needs the manifest')
        return null
      })

      expect(await poller.executePoll()).toBe('failure')
      expect(apiClient.pollLog).not.toHaveBeenCalled()
    })

    it('drops a page the server clock shows the device is behind for, rather than applying it', async () => {
      const page = response({ serverNow: 5000 })
      apiClient.pollLog.mockResolvedValue(page)
      puller.dropPageIfBehind.mockReturnValue(true)

      expect(await poller.executePoll()).toBe('success')

      expect(puller.dropPageIfBehind).toHaveBeenCalledWith(page)
      expect(puller.process).not.toHaveBeenCalled()
      // Only the read is dropped: catch-up's sync runs in the phase after it
      expect(runManifestPhase).toHaveBeenLastCalledWith('afterRead', expect.any(AbortSignal))
    })
  })
})

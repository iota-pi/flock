import type { Mock } from 'vitest'
import type { ItemId, SyncLogMessage } from '@vault/shared'
import { createLogExchange, type LogExchange, type LogExchangeDeps } from './LogExchange'
import { SyncSessionState } from './SyncSessionState'

type AnyMock = Mock<(...args: any[]) => any>

const ITEM = 'item-1' as ItemId
const MESSAGE: SyncLogMessage = { itemId: ITEM, encryptedMessage: { iv: 'iv', cipher: 'cipher', kver: '1' } }

function response(overrides: Record<string, unknown> = {}) {
  return { pushResults: [], entries: [], hasMore: false, serverNow: 1000, ...overrides }
}

describe('LogExchange', () => {
  let session: SyncSessionState
  let puller: {
    cursor: number
    recordOwnPushes: AnyMock
    dropPageIfBehind: AnyMock
    process: AnyMock
  }
  let apiClient: { pollLog: AnyMock }
  let exchange: LogExchange
  let controller: AbortController

  beforeEach(() => {
    controller = new AbortController()
    session = new SyncSessionState({ isLeader: true })
    puller = {
      cursor: 7,
      recordOwnPushes: vi.fn(),
      dropPageIfBehind: vi.fn().mockReturnValue(false),
      process: vi.fn().mockResolvedValue(undefined),
    }
    apiClient = { pollLog: vi.fn().mockResolvedValue(response()) }
    exchange = createLogExchange({
      accountId: 'account-1',
      session,
      puller: puller as unknown as LogExchangeDeps['puller'],
      apiClient,
    })
  })

  it('pushes and reads the log after the cursor', async () => {
    await exchange([MESSAGE], async () => {}, controller.signal)

    expect(apiClient.pollLog).toHaveBeenCalledWith(
      { account: 'account-1', push: [MESSAGE], after: 7 },
      { signal: controller.signal },
    )
    expect(puller.process).toHaveBeenCalledTimes(1)
  })

  it('does nothing unless the session may sync', async () => {
    session.setOnline(false)

    await expect(exchange([], async () => {}, controller.signal)).rejects.toThrow()
    expect(apiClient.pollLog).not.toHaveBeenCalled()
  })

  it('records acknowledgements before applying entries', async () => {
    const order: string[] = []
    const pushResults = [{ itemId: ITEM, seq: 8 }]
    apiClient.pollLog.mockResolvedValue(response({ pushResults }))
    puller.process.mockImplementation(async () => { order.push('process') })

    await exchange([MESSAGE], async results => {
      order.push(`acknowledged ${results.length}`)
    }, controller.signal)

    expect(puller.recordOwnPushes).toHaveBeenCalledWith(pushResults)
    expect(order).toEqual(['acknowledged 1', 'process'])
  })

  it.each([
    ['the signal aborts', () => controller.abort()],
    ['leadership moves', () => session.setLeader(false)],
    ['the device goes offline', () => session.setOnline(false)],
  ])('records what the server stored when %s during the request, then stops', async (_, interrupt) => {
    const pushResults = [{ itemId: ITEM, seq: 8 }]
    apiClient.pollLog.mockImplementation(async () => {
      interrupt()
      return response({ pushResults })
    })
    const onResults = vi.fn(async () => {})

    await expect(exchange([MESSAGE], onResults, controller.signal)).rejects.toThrow()

    expect(puller.recordOwnPushes).toHaveBeenCalledWith(pushResults)
    expect(onResults).toHaveBeenCalledWith(pushResults)
    expect(puller.process).not.toHaveBeenCalled()
  })

  // Its items can't be marked dirty any more, so the marks stay and the next session resends them
  it('records nothing when the session shuts down during the request', async () => {
    apiClient.pollLog.mockImplementation(async () => {
      session.markShutdown()
      controller.abort()
      return response({ pushResults: [{ itemId: ITEM, seq: 8 }] })
    })
    const onResults = vi.fn(async () => {})

    await expect(exchange([MESSAGE], onResults, controller.signal)).rejects.toThrow()

    expect(puller.recordOwnPushes).not.toHaveBeenCalled()
    expect(onResults).not.toHaveBeenCalled()
  })

  // Rule 4: the page is read again once a manifest sync has caught the device up
  it('drops a page when the server clock shows the device is behind', async () => {
    puller.dropPageIfBehind.mockReturnValue(true)

    await exchange([], async () => {}, controller.signal)

    expect(puller.dropPageIfBehind).toHaveBeenCalledWith(response())
    expect(puller.process).not.toHaveBeenCalled()
  })
})

import { BatchGetCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb'
import type { ItemId } from '@vault/shared'
import DynamoDriver from './driver'
import { BATCH_MAX_RETRIES, sendBatchWithRetry } from './batchRetry'

type Request = Record<string, string[]>

describe('sendBatchWithRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns after one send when nothing is unprocessed', async () => {
    const send = vi.fn(async (_: Request): Promise<Request | undefined> => ({}))

    await sendBatchWithRetry({ request: { t: ['a'] }, commandName: 'Cmd', unprocessedName: 'keys', send })

    expect(send).toHaveBeenCalledTimes(1)
  })

  it('resends the unprocessed part until nothing is left', async () => {
    const send = vi.fn<(request: Request) => Promise<Request | undefined>>()
      .mockResolvedValueOnce({ t: ['b', 'c'] })
      .mockResolvedValueOnce({ t: ['c'] })
      .mockResolvedValueOnce(undefined)

    const promise = sendBatchWithRetry({ request: { t: ['a', 'b', 'c'] }, commandName: 'Cmd', unprocessedName: 'keys', send })
    await vi.runAllTimersAsync()
    await promise

    expect(send.mock.calls.map(([request]) => request)).toEqual([
      { t: ['a', 'b', 'c'] },
      { t: ['b', 'c'] },
      { t: ['c'] },
    ])
  })

  it('gives up with an error once the retries run out', async () => {
    const send = vi.fn(async (_: Request): Promise<Request | undefined> => ({ t: ['a'] }))

    const promise = sendBatchWithRetry({ request: { t: ['a'] }, commandName: 'BatchGetCommand', unprocessedName: 'keys', send })
    const caught = promise.catch((error: unknown) => error)
    await vi.runAllTimersAsync()
    expect(await caught).toEqual(new Error(
      `Failed to execute BatchGetCommand after ${BATCH_MAX_RETRIES} retries due to DynamoDB unprocessed keys.`,
    ))

    expect(send).toHaveBeenCalledTimes(BATCH_MAX_RETRIES + 1)
  })

  it('propagates a thrown error without retrying, since the SDK has already retried it', async () => {
    const error = Object.assign(new Error('Throughput exceeded'), {
      name: 'ProvisionedThroughputExceededException',
      $retryable: { throttling: true },
    })
    const send = vi.fn<(request: Request) => Promise<Request | undefined>>()
      .mockResolvedValueOnce({ t: ['b'] })
      .mockRejectedValueOnce(error)

    const promise = sendBatchWithRetry({ request: { t: ['a', 'b'] }, commandName: 'Cmd', unprocessedName: 'keys', send })
    const caught = promise.catch((thrown: unknown) => thrown)
    await vi.runAllTimersAsync()
    expect(await caught).toBe(error)

    expect(send).toHaveBeenCalledTimes(2)
  })
})

describe('DynamoDriver batch operations', () => {
  let driver: DynamoDriver
  let mockSend: ReturnType<typeof vi.fn>

  beforeEach(() => {
    driver = new DynamoDriver()
    mockSend = vi.fn()
    ;(driver as any).internalClient = { send: mockSend }
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('fetchByIds dedupes keys and collects items across resends of unprocessed keys', async () => {
    mockSend.mockImplementation(async (command: BatchGetCommand) => {
      const [table, { Keys }] = Object.entries(command.input.RequestItems!)[0]
      if (Keys!.length === 2) {
        return {
          Responses: { [table]: [{ account: 'acc1', item: 'item1' }] },
          UnprocessedKeys: { [table]: { Keys: [Keys![1]] } },
        }
      }
      return { Responses: { [table]: [{ account: 'acc1', item: 'item2' }] }, UnprocessedKeys: {} }
    })

    const promise = driver.fetchByIds({ account: 'acc1', itemIds: ['item1', 'item2', 'item1'] as ItemId[] })
    await vi.runAllTimersAsync()
    const result = await promise

    expect(mockSend).toHaveBeenCalledTimes(2)
    expect(result.map(item => item.item)).toEqual(['item1', 'item2'])
  })

  it('fetchByIds sends 100-key batches in parallel', async () => {
    let inFlight = 0
    let maxInFlight = 0
    mockSend.mockImplementation(async (command: BatchGetCommand) => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await Promise.resolve()
      inFlight -= 1
      const [table, { Keys }] = Object.entries(command.input.RequestItems!)[0]
      return { Responses: { [table]: Keys }, UnprocessedKeys: {} }
    })

    const itemIds = Array.from({ length: 250 }, (_, i) => `item${i}` as ItemId)
    const result = await driver.fetchByIds({ account: 'acc1', itemIds })

    expect(mockSend).toHaveBeenCalledTimes(3)
    expect(maxInFlight).toBe(3)
    expect(result).toHaveLength(250)
  })

  it('fetchByIds sends nothing for no IDs', async () => {
    expect(await driver.fetchByIds({ account: 'acc1', itemIds: [] })).toEqual([])
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('pushSyncMessagesBatch resends unprocessed items', async () => {
    mockSend.mockImplementation(async (command: BatchWriteCommand) => {
      const [table, requests] = Object.entries(command.input.RequestItems!)[0]
      if (requests.length === 2) {
        return { UnprocessedItems: { [table]: [requests[1]] } }
      }
      return { UnprocessedItems: {} }
    })

    const promise = driver.pushSyncMessagesBatch({
      account: 'acc1',
      messages: [1, 2].map(cursor => ({
        itemId: 'item1' as ItemId,
        entry: { cursor, encryptedMessage: { iv: 'iv', cipher: 'cipher' }, createdAt: 1 },
        lastModified: 1,
      })),
    })
    await vi.runAllTimersAsync()
    await promise

    expect(mockSend).toHaveBeenCalledTimes(2)
    const resent = Object.values(mockSend.mock.calls[1][0].input.RequestItems)[0] as { PutRequest: { Item: { cursor: number } } }[]
    expect(resent.map(request => request.PutRequest.Item.cursor)).toEqual([2])
  })
})

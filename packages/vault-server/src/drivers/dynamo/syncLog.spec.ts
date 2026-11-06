import { GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb'
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb'
import { generateItemId, SYNC_LOG_TTL_DAYS, type SyncLogMessage } from '@vault/shared'
import DynamoDriver from './driver'
import { MAX_APPEND_ATTEMPTS } from './syncLog'
import { generateAccountId } from '../../util'

const driver = new DynamoDriver({ syncLogPageSize: 3 })

function message(cipher = 'cipher'): SyncLogMessage {
  return { itemId: generateItemId(), encryptedMessage: { iv: 'iv', cipher, kver: '1', format: 2 } }
}

function messages(count: number): SyncLogMessage[] {
  return Array.from({ length: count }, (_, index) => message(`cipher-${index}`))
}

function canceled(code: string) {
  return new TransactionCanceledException({
    message: 'Transaction cancelled',
    $metadata: {},
    CancellationReasons: [{ Code: code }],
  })
}

/** Reads the whole log, a page at a time */
async function readAll(account: string) {
  const entries = []
  let after = 0
  for (;;) {
    const page = await driver.readLog({ account, after })
    entries.push(...page.entries)
    after = entries.at(-1)?.seq ?? after
    if (!page.hasMore) return entries
  }
}

describe('sync log', () => {
  let account: string

  beforeAll(() => {
    driver.connect()
  })

  beforeEach(() => {
    account = generateAccountId(10)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('starts empty', async () => {
    await expect(driver.readLogHead({ account })).resolves.toBe(0)
    await expect(driver.readLog({ account, after: 0 })).resolves.toEqual({ entries: [], hasMore: false })
  })

  it('gives each message the next seq, across pushes, and reports them in order', async () => {
    const first = messages(2)
    const second = messages(1)

    await expect(driver.appendLog({ account, messages: first })).resolves.toEqual([
      { itemId: first[0].itemId, seq: 1 },
      { itemId: first[1].itemId, seq: 2 },
    ])
    await expect(driver.appendLog({ account, messages: second })).resolves.toEqual([
      { itemId: second[0].itemId, seq: 3 },
    ])
    await expect(driver.readLogHead({ account })).resolves.toBe(3)
  })

  it('keeps every field of the ciphertext, format included', async () => {
    const pushed = message()
    const before = Date.now()
    await driver.appendLog({ account, messages: [pushed] })

    const { entries } = await driver.readLog({ account, after: 0 })
    expect(entries).toEqual([{ ...pushed, seq: 1, createdAt: expect.any(Number) }])
    expect(entries[0].createdAt).toBeGreaterThanOrEqual(before)
  })

  it('expires rows after the TTL, but never the head row', async () => {
    await driver.appendLog({ account, messages: [message()] })

    const get = (seq: number) => driver.client.send(new GetCommand({
      TableName: driver.tables.syncLog,
      Key: { account, seq },
    }))
    const { Item: row } = await get(1)
    expect(row?.expiresAt).toBe(Math.floor(row?.createdAt / 1000) + SYNC_LOG_TTL_DAYS * 24 * 60 * 60)
    const { Item: head } = await get(0)
    expect(head).toEqual({ account, seq: 0, head: 1 })
  })

  it('reads strictly after a seq, and never returns the head row', async () => {
    await driver.appendLog({ account, messages: messages(3) })

    const fromStart = await driver.readLog({ account, after: 0 })
    expect(fromStart.entries.map(e => e.seq)).toEqual([1, 2, 3])
    const fromMiddle = await driver.readLog({ account, after: 2 })
    expect(fromMiddle.entries.map(e => e.seq)).toEqual([3])
    const fromHead = await driver.readLog({ account, after: 3 })
    expect(fromHead).toEqual({ entries: [], hasMore: false })
  })

  it('reads with strong consistency', async () => {
    const send = vi.spyOn(driver.client, 'send')
    await driver.readLog({ account, after: 0 })
    await driver.readLogHead({ account })

    expect(send.mock.calls.map(([command]) => (command.input as { ConsistentRead?: boolean }).ConsistentRead))
      .toEqual([true, true])
  })

  it('pages through the log with hasMore', async () => {
    await driver.appendLog({ account, messages: messages(7) })

    const page = await driver.readLog({ account, after: 0 })
    expect(page.entries).toHaveLength(3)
    expect(page.hasMore).toBe(true)
    expect((await readAll(account)).map(e => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7])
  })

  it('keeps accounts apart', async () => {
    const other = generateAccountId(10)
    await driver.appendLog({ account, messages: messages(2) })
    await expect(driver.appendLog({ account: other, messages: [message()] })).resolves.toMatchObject([{ seq: 1 }])
    await expect(driver.readLogHead({ account })).resolves.toBe(2)
  })

  it('keeps seqs contiguous when devices push at once', async () => {
    const pushes = await Promise.all([messages(2), messages(3), messages(1)].map(
      batch => driver.appendLog({ account, messages: batch }),
    ))

    const seqs = pushes.flat().map(result => result.seq).sort((a, b) => a - b)
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6])
    expect((await readAll(account)).map(e => e.seq)).toEqual(seqs)
    await expect(driver.readLogHead({ account })).resolves.toBe(6)
    // A push's own rows stay next to each other, because each is one transaction
    for (const push of pushes) {
      expect(push.at(-1)!.seq - push[0].seq).toBe(push.length - 1)
    }
  })

  it('splits a push over the row limit into transactions, in order', async () => {
    const send = vi.spyOn(driver.client, 'send')
    const pushed = messages(100)

    const results = await driver.appendLog({ account, messages: pushed })

    expect(results).toEqual(pushed.map(({ itemId }, index) => ({ itemId, seq: index + 1 })))
    const transactions = send.mock.calls.filter(([command]) => command instanceof TransactWriteCommand)
    expect(transactions.map(([command]) => (command.input as { TransactItems: unknown[] }).TransactItems.length))
      .toEqual([100, 2])
  })

  it('splits a push over the size limit into transactions', async () => {
    const send = vi.spyOn(driver.client, 'send')
    const pushed = Array.from({ length: 11 }, () => message('c'.repeat(350 * 1024)))

    const results = await driver.appendLog({ account, messages: pushed })

    expect(results.map(result => result.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
    const transactions = send.mock.calls.filter(([command]) => command instanceof TransactWriteCommand)
    expect(transactions).toHaveLength(2)
  })

  it('rereads the head and retries when a transaction is cancelled', async () => {
    const realSend = driver.client.send.bind(driver.client) as (command: unknown) => Promise<unknown>
    await driver.appendLog({ account, messages: [message()] })
    let failures = 2
    vi.spyOn(driver.client, 'send').mockImplementation(((command: unknown) => {
      if (command instanceof TransactWriteCommand && failures > 0) {
        failures -= 1
        return Promise.reject(canceled('TransactionConflict'))
      }
      return realSend(command)
    }) as never)

    await expect(driver.appendLog({ account, messages: [message()] })).resolves.toMatchObject([{ seq: 2 }])
    expect(failures).toBe(0)
  })

  it('gives up after its attempts, using no seq', async () => {
    const realSend = driver.client.send.bind(driver.client) as (command: unknown) => Promise<unknown>
    let attempts = 0
    const send = vi.spyOn(driver.client, 'send').mockImplementation(((command: unknown) => {
      if (command instanceof TransactWriteCommand) {
        attempts += 1
        return Promise.reject(canceled('ConditionalCheckFailed'))
      }
      return realSend(command)
    }) as never)

    await expect(driver.appendLog({ account, messages: [message()] })).rejects.toThrow('Transaction cancelled')
    expect(attempts).toBe(MAX_APPEND_ATTEMPTS)
    send.mockRestore()
    await expect(driver.readLogHead({ account })).resolves.toBe(0)
  }, 15_000)

  it('does not retry a transaction that can never succeed', async () => {
    const realSend = driver.client.send.bind(driver.client) as (command: unknown) => Promise<unknown>
    let attempts = 0
    vi.spyOn(driver.client, 'send').mockImplementation(((command: unknown) => {
      if (command instanceof TransactWriteCommand) {
        attempts += 1
        return Promise.reject(canceled('ValidationError'))
      }
      return realSend(command)
    }) as never)

    await expect(driver.appendLog({ account, messages: [message()] })).rejects.toThrow('Transaction cancelled')
    expect(attempts).toBe(1)
  })

  it('does not retry other errors', async () => {
    const realSend = driver.client.send.bind(driver.client) as (command: unknown) => Promise<unknown>
    let attempts = 0
    vi.spyOn(driver.client, 'send').mockImplementation(((command: unknown) => {
      if (command instanceof TransactWriteCommand) {
        attempts += 1
        return Promise.reject(new Error('Network down'))
      }
      return realSend(command)
    }) as never)

    await expect(driver.appendLog({ account, messages: [message()] })).rejects.toThrow('Network down')
    expect(attempts).toBe(1)
  })
})

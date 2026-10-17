import { handler, processMessage } from './worker'
import { sendPushNotification } from './webpush'

vi.mock('./webpush', () => ({
  sendPushNotification: vi.fn(),
}))

vi.mock('@aws-sdk/lib-dynamodb', () => {
  const sendMock = vi.fn().mockImplementation(command => {
    if (command.constructor.name === 'GetCommand') {
      return Promise.resolve({
        Item: {
          account: 'user-1',
          pushSubscriptions: [
            { endpoint: 'https://push.example.com/expired-sub' },
            { endpoint: 'https://push.example.com/valid-sub' },
          ],
        },
      })
    }
    return Promise.resolve({})
  })
  return {
    DynamoDBDocumentClient: {
      from: () => ({ send: sendMock }),
    },
    GetCommand: class GetCommand { constructor(public input: unknown) {} },
    UpdateCommand: class UpdateCommand { constructor(public input: unknown) {} },
  }
})

describe('notifier worker', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('processes message and sends push notifications with deep link payload', async () => {
    const mockSend = sendPushNotification as unknown as ReturnType<typeof vi.fn>
    mockSend.mockResolvedValue(undefined)

    const message = {
      accountId: 'user-1',
      pushSubscriptions: [
        { endpoint: 'https://push.example.com/sub-1', keys: { auth: 'a', p256dh: 'p' } },
      ],
    }

    await processMessage(message)

    expect(mockSend).toHaveBeenCalledWith(
      message.pushSubscriptions[0],
      {
        title: 'Prayer reminder',
        body: 'Time to pray for your flock.',
        url: '/',
        icon: '/android-chrome-192x192.png',
        badge: '/badge-96x96.png',
      },
    )
  })

  it('removes subscription on 404 or 410 push error', async () => {
    const mockSend = sendPushNotification as unknown as ReturnType<typeof vi.fn>
    mockSend.mockRejectedValue({ statusCode: 410 })

    const message = {
      accountId: 'user-1',
      pushSubscriptions: [
        { endpoint: 'https://push.example.com/expired-sub', keys: { auth: 'a', p256dh: 'p' } },
      ],
    }

    await processMessage(message)

    expect(mockSend).toHaveBeenCalled()
  })

  it('rethrows non-404/410 errors', async () => {
    const mockSend = sendPushNotification as unknown as ReturnType<typeof vi.fn>
    mockSend.mockRejectedValue({ statusCode: 500 })

    const message = {
      accountId: 'user-1',
      pushSubscriptions: [
        { endpoint: 'https://push.example.com/sub-err', keys: { auth: 'a', p256dh: 'p' } },
      ],
    }

    await expect(processMessage(message)).rejects.toEqual({ statusCode: 500 })
  })

  it('attempts every subscription when one fails, then fails the message', async () => {
    const mockSend = sendPushNotification as unknown as ReturnType<typeof vi.fn>
    mockSend
      .mockRejectedValueOnce({ statusCode: 500 })
      .mockResolvedValueOnce(undefined)

    const message = {
      accountId: 'user-1',
      pushSubscriptions: [
        { endpoint: 'https://push.example.com/sub-err', keys: { auth: 'a', p256dh: 'p' } },
        { endpoint: 'https://push.example.com/sub-ok', keys: { auth: 'a', p256dh: 'p' } },
      ],
    }

    await expect(processMessage(message)).rejects.toEqual({ statusCode: 500 })

    expect(mockSend).toHaveBeenCalledTimes(2)
    expect(mockSend).toHaveBeenLastCalledWith(message.pushSubscriptions[1], expect.anything())
  })

  it('combines several failures into an AggregateError', async () => {
    const mockSend = sendPushNotification as unknown as ReturnType<typeof vi.fn>
    mockSend
      .mockRejectedValueOnce({ statusCode: 500 })
      .mockRejectedValueOnce({ statusCode: 410 })
      .mockRejectedValueOnce({ statusCode: 429 })

    const message = {
      accountId: 'user-1',
      pushSubscriptions: [
        { endpoint: 'https://push.example.com/sub-err-1', keys: { auth: 'a', p256dh: 'p' } },
        { endpoint: 'https://push.example.com/expired-sub', keys: { auth: 'a', p256dh: 'p' } },
        { endpoint: 'https://push.example.com/sub-err-2', keys: { auth: 'a', p256dh: 'p' } },
      ],
    }

    const error = await processMessage(message).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors).toEqual([{ statusCode: 500 }, { statusCode: 429 }])
    expect(mockSend).toHaveBeenCalledTimes(3)
  })

  it('does not fail the message when every failure is a 404 or 410', async () => {
    const mockSend = sendPushNotification as unknown as ReturnType<typeof vi.fn>
    mockSend
      .mockRejectedValueOnce({ statusCode: 404 })
      .mockRejectedValueOnce({ statusCode: 410 })
      .mockResolvedValueOnce(undefined)

    const message = {
      accountId: 'user-1',
      pushSubscriptions: [
        { endpoint: 'https://push.example.com/expired-sub', keys: { auth: 'a', p256dh: 'p' } },
        { endpoint: 'https://push.example.com/gone-sub', keys: { auth: 'a', p256dh: 'p' } },
        { endpoint: 'https://push.example.com/valid-sub', keys: { auth: 'a', p256dh: 'p' } },
      ],
    }

    await expect(processMessage(message)).resolves.toBeUndefined()

    expect(mockSend).toHaveBeenCalledTimes(3)
  })

  it('handler parses SQS records and invokes processMessage', async () => {
    const mockSend = sendPushNotification as unknown as ReturnType<typeof vi.fn>
    mockSend.mockResolvedValue(undefined)

    const sqsEvent = {
      Records: [
        {
          messageId: 'message-1',
          body: JSON.stringify({
            accountId: 'user-1',
            pushSubscriptions: [{ endpoint: 'https://push.example.com/sub-1', keys: { auth: 'a', p256dh: 'p' } }],
          }),
        },
      ],
    }

    await expect(handler(sqsEvent)).resolves.toEqual({ batchItemFailures: [] })

    expect(mockSend).toHaveBeenCalledTimes(1)
  })

  it('handler reports only the records that failed', async () => {
    const mockSend = sendPushNotification as unknown as ReturnType<typeof vi.fn>
    mockSend
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce({ statusCode: 500 })
      .mockResolvedValueOnce(undefined)
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const record = (messageId: string) => ({
      messageId,
      body: JSON.stringify({
        accountId: 'user-1',
        pushSubscriptions: [{ endpoint: `https://push.example.com/${messageId}`, keys: { auth: 'a', p256dh: 'p' } }],
      }),
    })

    const result = await handler({ Records: [record('message-1'), record('message-2'), record('message-3')] })

    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: 'message-2' }] })
    expect(mockSend).toHaveBeenCalledTimes(3)
  })
})

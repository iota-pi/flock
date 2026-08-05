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
        icon: '/flock.png',
        badge: '/flock.png',
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

  it('handler parses SQS records and invokes processMessage', async () => {
    const mockSend = sendPushNotification as unknown as ReturnType<typeof vi.fn>
    mockSend.mockResolvedValue(undefined)

    const sqsEvent = {
      Records: [
        {
          body: JSON.stringify({
            accountId: 'user-1',
            pushSubscriptions: [{ endpoint: 'https://push.example.com/sub-1', keys: { auth: 'a', p256dh: 'p' } }],
          }),
        },
      ],
    }

    await handler(sqsEvent)

    expect(mockSend).toHaveBeenCalledTimes(1)
  })
})

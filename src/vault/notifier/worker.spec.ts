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

  const keys = { auth: 'a', p256dh: 'p' }
  const reminder = (endpoint: string) => ({
    accountId: 'user-1',
    subscription: { endpoint: `https://push.example.com/${endpoint}`, keys },
    topic: 'reminder-2026-10-17',
  })

  it('sends the reminder payload with the message topic', async () => {
    const mockSend = sendPushNotification as unknown as ReturnType<typeof vi.fn>
    mockSend.mockResolvedValue(undefined)

    const message = reminder('sub-1')
    await processMessage(message)

    expect(mockSend).toHaveBeenCalledWith(
      message.subscription,
      {
        title: 'Prayer reminder',
        body: 'Time to pray for your flock.',
        url: '/',
        icon: '/android-chrome-192x192.png',
        badge: '/badge-96x96.png',
      },
      { topic: 'reminder-2026-10-17' },
    )
  })

  it('removes subscription on 404 or 410 push error', async () => {
    const mockSend = sendPushNotification as unknown as ReturnType<typeof vi.fn>
    mockSend.mockRejectedValue({ statusCode: 410 })

    await expect(processMessage(reminder('expired-sub'))).resolves.toBeUndefined()

    expect(mockSend).toHaveBeenCalled()
  })

  it('rethrows non-404/410 errors', async () => {
    const mockSend = sendPushNotification as unknown as ReturnType<typeof vi.fn>
    mockSend.mockRejectedValue({ statusCode: 500 })

    await expect(processMessage(reminder('sub-err'))).rejects.toEqual({ statusCode: 500 })
  })

  it('handler parses SQS records and invokes processMessage', async () => {
    const mockSend = sendPushNotification as unknown as ReturnType<typeof vi.fn>
    mockSend.mockResolvedValue(undefined)

    const sqsEvent = {
      Records: [{ messageId: 'message-1', body: JSON.stringify(reminder('sub-1')) }],
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

    const record = (messageId: string) => ({ messageId, body: JSON.stringify(reminder(messageId)) })

    const result = await handler({ Records: [record('message-1'), record('message-2'), record('message-3')] })

    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: 'message-2' }] })
    expect(mockSend).toHaveBeenCalledTimes(3)
  })
})

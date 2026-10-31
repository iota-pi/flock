import { handler, processMessage } from './worker'
import { sendPushNotification } from './webpush'
import * as webpushModule from './webpush'
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { WebPushError } from 'web-push'
import { spyOnExports } from '../../utils/testUtils'

// The worker creates its client on import, so intercept what it sends
beforeEach(() => {
  spyOnExports(webpushModule, {
    sendPushNotification: vi.fn(),
  })
  vi.spyOn(DynamoDBDocumentClient.prototype, 'send').mockImplementation(async (command: unknown) => {
    if (command instanceof GetCommand) {
      return {
        Item: {
          account: 'user-1',
          pushSubscriptions: [
            { endpoint: 'https://push.example.com/expired-sub' },
            { endpoint: 'https://push.example.com/valid-sub' },
          ],
        },
      }
    }
    return {}
  })
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

  it('removes a subscription made with another VAPID key', async () => {
    const mockSend = sendPushNotification as unknown as ReturnType<typeof vi.fn>
    mockSend.mockRejectedValue(new WebPushError(
      'Received unexpected response code',
      403,
      {},
      'the VAPID credentials in the authorization header do not correspond to the credentials used to create the subscriptions.\n',
      'https://push.example.com/expired-sub',
    ))
    const mockDbSend = DynamoDBDocumentClient.prototype.send as unknown as ReturnType<typeof vi.fn>

    await expect(processMessage(reminder('expired-sub'))).resolves.toBeUndefined()

    const update = mockDbSend.mock.calls.map(([command]) => command).find(command => command instanceof UpdateCommand)
    expect(update?.input.ExpressionAttributeValues).toEqual({
      ':pushSubscriptions': [{ endpoint: 'https://push.example.com/valid-sub' }],
    })
  })

  it('rethrows other 403 errors', async () => {
    const mockSend = sendPushNotification as unknown as ReturnType<typeof vi.fn>
    const error = new WebPushError('Received unexpected response code', 403, {}, 'Forbidden', 'https://push.example.com/sub-1')
    mockSend.mockRejectedValue(error)

    await expect(processMessage(reminder('sub-1'))).rejects.toBe(error)
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

  it('handler logs push errors without the subscription endpoint', async () => {
    const endpoint = 'https://push.example.com/private-sub'
    const mockSend = sendPushNotification as unknown as ReturnType<typeof vi.fn>
    mockSend.mockRejectedValueOnce(new WebPushError('Received unexpected response code', 403, {}, 'VAPID mismatch', endpoint))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    await handler({ Records: [{ messageId: 'message-1', body: JSON.stringify(reminder('private-sub')) }] })

    expect(consoleError).toHaveBeenCalledWith(
      'Failed to process push notification message message-1',
      { name: 'WebPushError', message: 'Received unexpected response code', statusCode: 403, body: 'VAPID mismatch' },
    )
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(endpoint)
  })
})

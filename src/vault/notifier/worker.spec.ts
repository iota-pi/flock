import { handler, processMessage, removeSubscription } from './worker'
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

  it('sends the reminder payload with the message topic and a TTL', async () => {
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
      { topic: 'reminder-2026-10-17', ttl: 21_600 },
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
    expect(update?.input.ExpressionAttributeValues).toMatchObject({
      ':pushSubscriptions': [{ endpoint: 'https://push.example.com/valid-sub' }],
    })
  })

  describe('removeSubscription', () => {
    const subscriptions = [
      { endpoint: 'https://push.example.com/expired-sub' },
      { endpoint: 'https://push.example.com/valid-sub' },
    ]
    const conditionFailure = () => Object.assign(new Error('The conditional request failed'), {
      name: 'ConditionalCheckFailedException',
    })
    const mockDb = () => DynamoDBDocumentClient.prototype.send as unknown as ReturnType<typeof vi.fn>
    const sentCommands = () => mockDb().mock.calls.map(([command]) => command)
    const updates = () => sentCommands().filter(command => command instanceof UpdateCommand) as UpdateCommand[]

    it('writes only if the account exists and its subscriptions are unchanged', async () => {
      await removeSubscription('user-1', 'https://push.example.com/expired-sub')

      const [get] = sentCommands()
      expect(get).toBeInstanceOf(GetCommand)
      expect((get as GetCommand).input.ConsistentRead).toBe(true)
      expect(updates()).toHaveLength(1)
      expect(updates()[0].input).toMatchObject({
        ConditionExpression: 'attribute_exists(account) AND pushSubscriptions = :currentSubscriptions',
        ExpressionAttributeValues: {
          ':pushSubscriptions': [{ endpoint: 'https://push.example.com/valid-sub' }],
          ':currentSubscriptions': subscriptions,
        },
      })
    })

    it('does not write when the account is missing', async () => {
      mockDb().mockImplementation(async () => ({}))

      await expect(removeSubscription('user-1', 'https://push.example.com/expired-sub')).resolves.toBeUndefined()

      expect(updates()).toHaveLength(0)
    })

    it('does not write when the subscription is already gone', async () => {
      await removeSubscription('user-1', 'https://push.example.com/other-sub')

      expect(updates()).toHaveLength(0)
    })

    it('re-reads and retries when the subscriptions changed in between', async () => {
      const added = { endpoint: 'https://push.example.com/new-sub' }
      let reads = 0
      let writes = 0
      mockDb().mockImplementation(async (command: unknown) => {
        if (command instanceof GetCommand) {
          reads += 1
          return { Item: { account: 'user-1', pushSubscriptions: reads === 1 ? subscriptions : [...subscriptions, added] } }
        }
        writes += 1
        if (writes === 1) {
          throw conditionFailure()
        }
        return {}
      })

      await removeSubscription('user-1', 'https://push.example.com/expired-sub')

      expect(updates()).toHaveLength(2)
      expect(updates()[1].input.ExpressionAttributeValues).toEqual({
        ':pushSubscriptions': [{ endpoint: 'https://push.example.com/valid-sub' }, added],
        ':currentSubscriptions': [...subscriptions, added],
      })
    })

    it('gives up after repeated conflicts so the message is retried', async () => {
      mockDb().mockImplementation(async (command: unknown) => {
        if (command instanceof GetCommand) {
          return { Item: { account: 'user-1', pushSubscriptions: subscriptions } }
        }
        throw conditionFailure()
      })

      await expect(removeSubscription('user-1', 'https://push.example.com/expired-sub'))
        .rejects.toMatchObject({ name: 'ConditionalCheckFailedException' })
      expect(updates()).toHaveLength(3)
    })

    it('rethrows other write errors without retrying', async () => {
      const error = new Error('Throttled')
      mockDb().mockImplementation(async (command: unknown) => {
        if (command instanceof GetCommand) {
          return { Item: { account: 'user-1', pushSubscriptions: subscriptions } }
        }
        throw error
      })

      await expect(removeSubscription('user-1', 'https://push.example.com/expired-sub')).rejects.toBe(error)
      expect(updates()).toHaveLength(1)
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

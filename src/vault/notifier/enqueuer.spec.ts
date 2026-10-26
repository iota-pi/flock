import { getLocalDateString, handler, isReminderSnoozed, isReminderTimeMatch } from './enqueuer'
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { SQSClient } from '@aws-sdk/client-sqs'

const scanMock = vi.fn()
const sqsSendMock = vi.fn()

// The enqueuer creates its clients on import, so intercept what they send
beforeEach(() => {
  vi.spyOn(DynamoDBDocumentClient.prototype, 'send').mockImplementation(scanMock)
  vi.spyOn(SQSClient.prototype, 'send').mockImplementation(sqsSendMock)
})

describe('isReminderTimeMatch', () => {
  it('returns true when current local time exactly matches reminder time', () => {
    // 2026-08-05 08:00 UTC
    const nowUtc = new Date('2026-08-05T08:00:00Z')
    expect(isReminderTimeMatch(nowUtc, '08:00', 'UTC')).toBe(true)
  })

  it('returns true when current local time is within the 15-minute cron window', () => {
    // 2026-08-05 08:05 UTC (5 minutes after 08:00 reminder)
    const nowUtc1 = new Date('2026-08-05T08:05:00Z')
    expect(isReminderTimeMatch(nowUtc1, '08:00', 'UTC')).toBe(true)

    // 2026-08-05 08:14 UTC (14 minutes after 08:00 reminder)
    const nowUtc2 = new Date('2026-08-05T08:14:59Z')
    expect(isReminderTimeMatch(nowUtc2, '08:00', 'UTC')).toBe(true)
  })

  it('returns false when current local time is outside the 15-minute cron window', () => {
    // 2026-08-05 08:15 UTC (15 minutes after 08:00 reminder)
    const nowUtc1 = new Date('2026-08-05T08:15:00Z')
    expect(isReminderTimeMatch(nowUtc1, '08:00', 'UTC')).toBe(false)

    // 2026-08-05 07:59 UTC (1 minute before 08:00 reminder)
    const nowUtc2 = new Date('2026-08-05T07:59:59Z')
    expect(isReminderTimeMatch(nowUtc2, '08:00', 'UTC')).toBe(false)
  })

  it('correctly handles timezones', () => {
    // 2026-08-05 22:00:00Z corresponds to 2026-08-06 08:00:00 AEST (UTC+10)
    const nowUtc = new Date('2026-08-05T22:00:00Z')
    expect(isReminderTimeMatch(nowUtc, '08:00', 'Australia/Sydney')).toBe(true)
    expect(isReminderTimeMatch(nowUtc, '22:00', 'UTC')).toBe(true)
    expect(isReminderTimeMatch(nowUtc, '08:00', 'UTC')).toBe(false)
  })

  it('handles midnight wrap-around', () => {
    // 2026-08-06 00:05 UTC (10 minutes after 23:55 reminder)
    const nowUtc = new Date('2026-08-06T00:05:00Z')
    expect(isReminderTimeMatch(nowUtc, '23:55', 'UTC')).toBe(true)
  })

  it('supports custom windowMinutes interval', () => {
    // 2026-08-05 08:04 UTC (4 minutes after 08:00 reminder)
    const nowUtc = new Date('2026-08-05T08:04:00Z')
    // With a 5 minute window: 4 < 5 -> true
    expect(isReminderTimeMatch(nowUtc, '08:00', 'UTC', 5)).toBe(true)

    // 2026-08-05 08:06 UTC (6 minutes after 08:00 reminder)
    const nowUtc6 = new Date('2026-08-05T08:06:00Z')
    // With a 5 minute window: 6 < 5 -> false
    expect(isReminderTimeMatch(nowUtc6, '08:00', 'UTC', 5)).toBe(false)
  })

  it('returns false for invalid time formats or timezones', () => {
    const nowUtc = new Date('2026-08-05T08:00:00Z')
    expect(isReminderTimeMatch(nowUtc, 'invalid', 'UTC')).toBe(false)
    expect(isReminderTimeMatch(nowUtc, '08:00', 'Invalid/Timezone')).toBe(false)
  })
})

describe('isReminderSnoozed', () => {
  it('returns true when current local date is strictly before snoozeRemindersUntil', () => {
    // 2026-09-20 08:00 UTC, snoozed until 2026-09-21
    const nowUtc = new Date('2026-09-20T08:00:00Z')
    expect(isReminderSnoozed(nowUtc, 'UTC', '2026-09-21')).toBe(true)
  })

  it('returns false when current local date matches or exceeds snoozeRemindersUntil', () => {
    // 2026-09-21 08:00 UTC, snoozed until 2026-09-21
    const nowUtc = new Date('2026-09-21T08:00:00Z')
    expect(isReminderSnoozed(nowUtc, 'UTC', '2026-09-21')).toBe(false)

    // 2026-09-22 08:00 UTC, snoozed until 2026-09-21
    const laterUtc = new Date('2026-09-22T08:00:00Z')
    expect(isReminderSnoozed(laterUtc, 'UTC', '2026-09-21')).toBe(false)
  })

  it('returns false when snoozeRemindersUntil is undefined or null', () => {
    const nowUtc = new Date('2026-09-20T08:00:00Z')
    expect(isReminderSnoozed(nowUtc, 'UTC', undefined)).toBe(false)
  })

  it('correctly respects timezone boundaries', () => {
    // 2026-09-19 23:00:00Z is 2026-09-20 09:00:00 AEST (UTC+10)
    const nowUtc = new Date('2026-09-19T23:00:00Z')

    // In UTC, today is 2026-09-19. If snoozed until 2026-09-20, in UTC today < 2026-09-20 is true
    expect(isReminderSnoozed(nowUtc, 'UTC', '2026-09-20')).toBe(true)

    // But in Australia/Sydney, today is 2026-09-20. So 2026-09-20 < 2026-09-20 is false (snooze expired!)
    expect(isReminderSnoozed(nowUtc, 'Australia/Sydney', '2026-09-20')).toBe(false)

    // And in Australia/Sydney, if snoozed until 2026-09-21, 2026-09-20 < 2026-09-21 is true
    expect(isReminderSnoozed(nowUtc, 'Australia/Sydney', '2026-09-21')).toBe(true)
  })

  it('returns false gracefully for invalid timezone', () => {
    const nowUtc = new Date('2026-09-20T08:00:00Z')
    expect(isReminderSnoozed(nowUtc, 'Invalid/Timezone', '2026-09-21')).toBe(false)
  })
})

describe('getLocalDateString', () => {
  it('formats the date in the given timezone', () => {
    const nowUtc = new Date('2026-09-19T23:00:00Z')
    expect(getLocalDateString(nowUtc, 'UTC')).toBe('2026-09-19')
    expect(getLocalDateString(nowUtc, 'Australia/Sydney')).toBe('2026-09-20')
  })
})

describe('handler', () => {
  const originalEnv = process.env

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    // 08:00 in Sydney on 2026-09-20
    vi.setSystemTime(new Date('2026-09-19T22:00:00Z'))
    process.env = { ...originalEnv, PUSH_NOTIFICATIONS_QUEUE_URL: 'https://sqs.example.com/queue' }
    sqsSendMock.mockResolvedValue({ Failed: [] })
  })

  afterEach(() => {
    vi.useRealTimers()
    process.env = originalEnv
  })

  const subscription = (endpoint: string) => ({
    endpoint: `https://push.example.com/${endpoint}`,
    keys: { auth: 'a', p256dh: 'p' },
  })

  it('enqueues one message per subscription with a daily topic', async () => {
    scanMock.mockResolvedValue({
      Items: [
        {
          account: 'user-1',
          pushSubscriptions: [subscription('phone'), subscription('laptop')],
          reminderEnabled: true,
          reminderTime: '08:00',
          reminderTimezone: 'Australia/Sydney',
        },
        {
          account: 'user-2',
          pushSubscriptions: [subscription('other')],
          reminderEnabled: true,
          reminderTime: '12:00',
          reminderTimezone: 'Australia/Sydney',
        },
      ],
    })

    await handler()

    expect(sqsSendMock).toHaveBeenCalledTimes(1)
    const entries = sqsSendMock.mock.calls[0][0].input.Entries as Array<{ Id: string, MessageBody: string }>
    expect(entries.map(entry => entry.Id)).toEqual(['0', '1'])
    expect(entries.map(entry => JSON.parse(entry.MessageBody))).toEqual([
      { accountId: 'user-1', subscription: subscription('phone'), topic: 'reminder-2026-09-20' },
      { accountId: 'user-1', subscription: subscription('laptop'), topic: 'reminder-2026-09-20' },
    ])
  })

  it('splits more than 10 subscriptions across batches', async () => {
    scanMock.mockResolvedValue({
      Items: [{
        account: 'user-1',
        pushSubscriptions: Array.from({ length: 12 }, (_, i) => subscription(`sub-${i}`)),
        reminderEnabled: true,
        reminderTime: '08:00',
        reminderTimezone: 'Australia/Sydney',
      }],
    })

    await handler()

    expect(sqsSendMock).toHaveBeenCalledTimes(2)
    expect(sqsSendMock.mock.calls[0][0].input.Entries).toHaveLength(10)
    expect(sqsSendMock.mock.calls[1][0].input.Entries).toHaveLength(2)
  })
})

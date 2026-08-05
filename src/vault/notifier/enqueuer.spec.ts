import { isReminderTimeMatch } from './enqueuer'

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

  it('returns false for invalid time formats or timezones', () => {
    const nowUtc = new Date('2026-08-05T08:00:00Z')
    expect(isReminderTimeMatch(nowUtc, 'invalid', 'UTC')).toBe(false)
    expect(isReminderTimeMatch(nowUtc, '08:00', 'Invalid/Timezone')).toBe(false)
  })
})

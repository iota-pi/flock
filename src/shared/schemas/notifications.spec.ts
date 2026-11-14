import { isKnownTimeZone, ReminderSettingsBodySchema } from './notifications'

describe('ReminderSettingsBodySchema', () => {
  const valid = { account: 'abcd1234', reminderEnabled: true, reminderTime: '08:00', reminderTimezone: 'Australia/Sydney' }

  it('accepts real settings', () => {
    expect(ReminderSettingsBodySchema.safeParse(valid).success).toBe(true)
  })

  it.each(['00:00', '23:59', '12:30'])('accepts the time %s', reminderTime => {
    expect(ReminderSettingsBodySchema.safeParse({ ...valid, reminderTime }).success).toBe(true)
  })

  it.each(['24:00', '12:60', '8:00 ', 'ab:cd', '0800', ''])('rejects the time %j', reminderTime => {
    expect(ReminderSettingsBodySchema.safeParse({ ...valid, reminderTime }).success).toBe(false)
  })

  it.each(['Nope/Zone', '', 'x'.repeat(65)])('rejects the time zone %j', reminderTimezone => {
    expect(ReminderSettingsBodySchema.safeParse({ ...valid, reminderTimezone }).success).toBe(false)
  })

  it('rejects an oversized account ID', () => {
    expect(ReminderSettingsBodySchema.safeParse({ ...valid, account: 'a'.repeat(65) }).success).toBe(false)
  })
})

describe('isKnownTimeZone', () => {
  // Intl.supportedValuesOf('timeZone') leaves out UTC and lists only one of the two names for Kolkata
  it.each(['UTC', 'Asia/Calcutta', 'Asia/Kolkata', 'Australia/Sydney'])('accepts %s', timeZone => {
    expect(isKnownTimeZone(timeZone)).toBe(true)
  })

  it('rejects a made-up zone', () => {
    expect(isKnownTimeZone('Mars/Olympus_Mons')).toBe(false)
  })
})

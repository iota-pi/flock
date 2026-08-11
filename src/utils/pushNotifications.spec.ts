import { checkSubscription, syncReminderTimezone } from './pushNotifications'
import { getReminderSettings, updateReminderSettings } from '../api/vault/client'

vi.mock('../api/vault/client', () => ({
  addPushSubscription: vi.fn(),
  deletePushSubscription: vi.fn(),
  updateReminderSettings: vi.fn().mockResolvedValue(undefined),
  getReminderSettings: vi.fn(),
}))

describe('pushNotifications utility', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('checkSubscription', () => {
    it('returns null when notification permission is not granted', async () => {
      Object.defineProperty(globalThis, 'Notification', {
        value: { permission: 'denied' },
        writable: true,
      })

      const result = await checkSubscription('user-1')
      expect(result).toBeNull()
    })

    it('returns hours when notifications granted and enabled', async () => {
      Object.defineProperty(globalThis, 'Notification', {
        value: { permission: 'granted' },
        writable: true,
      })

      const mockGet = getReminderSettings as unknown as ReturnType<typeof vi.fn>
      mockGet.mockResolvedValue({
        reminderEnabled: true,
        reminderTime: '09:00',
        reminderTimezone: 'UTC',
      })

      const result = await checkSubscription('user-1')
      expect(result).toEqual({ hours: [9] })
    })

    it('returns null when reminder is disabled', async () => {
      Object.defineProperty(globalThis, 'Notification', {
        value: { permission: 'granted' },
        writable: true,
      })

      const mockGet = getReminderSettings as unknown as ReturnType<typeof vi.fn>
      mockGet.mockResolvedValue({
        reminderEnabled: false,
        reminderTime: '09:00',
        reminderTimezone: 'UTC',
      })

      const result = await checkSubscription('user-1')
      expect(result).toBeNull()
    })
  })

  describe('syncReminderTimezone', () => {
    it('does nothing if reminder is disabled', async () => {
      const mockGet = getReminderSettings as unknown as ReturnType<typeof vi.fn>
      mockGet.mockResolvedValue({
        reminderEnabled: false,
        reminderTime: '08:00',
        reminderTimezone: 'America/New_York',
      })

      const updated = await syncReminderTimezone('user-1')
      expect(updated).toBe(false)
      expect(updateReminderSettings).not.toHaveBeenCalled()
    })

    it('updates reminderTimezone when local timezone differs from stored timezone', async () => {
      const mockGet = getReminderSettings as unknown as ReturnType<typeof vi.fn>
      mockGet.mockResolvedValue({
        reminderEnabled: true,
        reminderTime: '08:00',
        reminderTimezone: 'Old/Timezone',
      })

      const currentLocalTz = Intl.DateTimeFormat().resolvedOptions().timeZone

      const updated = await syncReminderTimezone('user-1')
      expect(updated).toBe(true)
      expect(updateReminderSettings).toHaveBeenCalledWith('user-1', {
        reminderEnabled: true,
        reminderTime: '08:00',
        reminderTimezone: currentLocalTz,
      })
    })

    it('does nothing if local timezone matches stored timezone', async () => {
      const currentLocalTz = Intl.DateTimeFormat().resolvedOptions().timeZone
      const mockGet = getReminderSettings as unknown as ReturnType<typeof vi.fn>
      mockGet.mockResolvedValue({
        reminderEnabled: true,
        reminderTime: '08:00',
        reminderTimezone: currentLocalTz,
      })

      const updated = await syncReminderTimezone('user-1')
      expect(updated).toBe(false)
      expect(updateReminderSettings).not.toHaveBeenCalled()
    })
  })
})

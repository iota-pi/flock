import { checkSubscription, syncReminderTimezone, clearReminderNotifications } from './pushNotifications'
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

  describe('clearReminderNotifications', () => {
    it('does nothing when navigator has no serviceWorker', async () => {
      const originalServiceWorker = navigator.serviceWorker
      try {
        Object.defineProperty(navigator, 'serviceWorker', {
          value: undefined,
          configurable: true,
        })
        await expect(clearReminderNotifications()).resolves.toBeUndefined()
      } finally {
        Object.defineProperty(navigator, 'serviceWorker', {
          value: originalServiceWorker,
          configurable: true,
        })
      }
    })

    it('posts CLEAR_REMINDER_NOTIFICATIONS to active worker and closes prayer-reminder notifications', async () => {
      const mockPostMessage = vi.fn()
      const closeNotification1 = vi.fn()
      const closeNotification2 = vi.fn()
      const closeOtherNotification = vi.fn()

      const notif1 = { tag: 'prayer-reminder', close: closeNotification1 }
      const notif2 = { tag: '', close: closeNotification2 }
      const notifOther = { tag: 'unrelated-tag', close: closeOtherNotification }

      const mockRegistration = {
        active: { postMessage: mockPostMessage },
        getNotifications: vi.fn().mockResolvedValue([notif1, notif2, notifOther]),
      }

      Object.defineProperty(navigator, 'serviceWorker', {
        value: {
          getRegistration: vi.fn().mockResolvedValue(mockRegistration),
        },
        configurable: true,
      })

      await clearReminderNotifications()

      expect(mockPostMessage).toHaveBeenCalledWith({ type: 'CLEAR_REMINDER_NOTIFICATIONS' })
      expect(closeNotification1).toHaveBeenCalled()
      expect(closeNotification2).toHaveBeenCalled()
      expect(closeOtherNotification).not.toHaveBeenCalled()
    })
  })
})

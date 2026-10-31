import {
  checkSubscription,
  syncReminderTimezone,
  clearReminderNotifications,
  refreshPushSubscription,
  subscribe,
} from './pushNotifications'
import {
  addPushSubscription,
  deletePushSubscription,
  getReminderSettings,
  updateReminderSettings,
} from '../api/notificationClient'
import * as notificationClientModule from '../api/notificationClient'
import { spyOnExports } from './testUtils'

beforeEach(() => {
  spyOnExports(notificationClientModule, {
    addPushSubscription: vi.fn(),
    deletePushSubscription: vi.fn(),
    updateReminderSettings: vi.fn().mockResolvedValue(undefined),
    getReminderSettings: vi.fn(),
  })
})

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

  describe('VAPID key changes', () => {
    const originalServiceWorker = navigator.serviceWorker
    // Base64url for the bytes 1, 2, 3
    const key = 'AQID'

    const browserSubscription = (endpoint: string, keyBytes: number[] | null) => ({
      endpoint,
      options: { applicationServerKey: keyBytes && new Uint8Array(keyBytes).buffer },
      unsubscribe: vi.fn().mockResolvedValue(true),
      toJSON: () => ({ endpoint, keys: { auth: 'auth', p256dh: 'p256dh' } }),
    })

    function stubPushManager(existing: ReturnType<typeof browserSubscription> | null) {
      const pushManager = {
        getSubscription: vi.fn().mockResolvedValue(existing),
        subscribe: vi.fn().mockResolvedValue(browserSubscription('https://push.example.com/new', [1, 2, 3])),
      }
      Object.defineProperty(navigator, 'serviceWorker', {
        value: { getRegistration: vi.fn().mockResolvedValue({ pushManager }) },
        configurable: true,
      })
      return pushManager
    }

    beforeEach(() => {
      Object.defineProperty(globalThis, 'Notification', {
        value: { permission: 'granted', requestPermission: vi.fn().mockResolvedValue('granted') },
        writable: true,
      })
    })

    afterEach(() => {
      Object.defineProperty(navigator, 'serviceWorker', { value: originalServiceWorker, configurable: true })
    })

    it('replaces a subscription made with another key', async () => {
      const stale = browserSubscription('https://push.example.com/old', [9, 9, 9])
      const pushManager = stubPushManager(stale)

      await expect(refreshPushSubscription('user-1', key)).resolves.toBe(true)

      expect(deletePushSubscription).toHaveBeenCalledWith('user-1', 'https://push.example.com/old')
      expect(stale.unsubscribe).toHaveBeenCalled()
      expect(pushManager.subscribe).toHaveBeenCalledWith({
        applicationServerKey: new Uint8Array([1, 2, 3]),
        userVisibleOnly: true,
      })
      expect(addPushSubscription).toHaveBeenCalledWith('user-1', {
        endpoint: 'https://push.example.com/new',
        keys: { auth: 'auth', p256dh: 'p256dh' },
      })
    })

    it('keeps a subscription made with the current key', async () => {
      const pushManager = stubPushManager(browserSubscription('https://push.example.com/current', [1, 2, 3]))

      await expect(refreshPushSubscription('user-1', key)).resolves.toBe(false)

      expect(pushManager.subscribe).not.toHaveBeenCalled()
      expect(addPushSubscription).not.toHaveBeenCalled()
    })

    it('keeps a subscription whose key the browser does not report', async () => {
      const pushManager = stubPushManager(browserSubscription('https://push.example.com/unknown', null))

      await expect(refreshPushSubscription('user-1', key)).resolves.toBe(false)

      expect(pushManager.subscribe).not.toHaveBeenCalled()
    })

    it('does not subscribe a device that has no subscription', async () => {
      const pushManager = stubPushManager(null)

      await expect(refreshPushSubscription('user-1', key)).resolves.toBe(false)

      expect(pushManager.subscribe).not.toHaveBeenCalled()
    })

    it('subscribing replaces a subscription made with another key', async () => {
      const stale = browserSubscription('https://push.example.com/old', [9, 9, 9])
      stubPushManager(stale)

      await subscribe('user-1', [9], key)

      expect(stale.unsubscribe).toHaveBeenCalled()
      expect(addPushSubscription).toHaveBeenCalledWith('user-1', {
        endpoint: 'https://push.example.com/new',
        keys: { auth: 'auth', p256dh: 'p256dh' },
      })
    })
  })
})

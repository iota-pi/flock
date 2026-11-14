import { flockAccountsRouter } from './flockAccounts'
import { hashSessionToken, SESSION_EXPIRY_MS } from '@vault/server'

const endpoint = (name: string) => `https://fcm.googleapis.com/fcm/send/${name}`

/** A stored account record with an active session for `session-token` */
function storedAccount(fields: Record<string, unknown> = {}) {
  return {
    account: 'acct-1',
    ...fields,
    sessions: [{ token: hashSessionToken('session-token'), expiry: Date.now() + SESSION_EXPIRY_MS }],
  }
}


function createContext(overrides?: { authToken?: string, sessionValid?: boolean }) {
  const sessionValid = overrides?.sessionValid ?? true
  const vault = {
    createAccount: vi.fn(async () => true),
    updateAccountData: vi.fn(async () => undefined),
    getAccountSalt: vi.fn(async () => 'salt-1'),
    getAccountRecord: vi.fn(async () => (sessionValid ? storedAccount({ metadata: { theme: 'light' } }) : undefined)),
    extendSession: vi.fn(async () => undefined),
  }

  return {
    authToken: overrides?.authToken ?? 'session-token',
    vault,
  }
}

describe('flockAccountsRouter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('updates snoozeRemindersUntil with specified date', async () => {
    const ctx = createContext()
    const caller = flockAccountsRouter.createCaller(ctx as any)

    const result = await caller.snoozeReminders({
      account: 'acct-1',
      snoozeUntilDate: '2026-09-25',
    })

    expect(result).toEqual({ success: true, snoozeRemindersUntil: '2026-09-25' })
    expect(ctx.vault.updateAccountData).toHaveBeenCalledWith({
      account: 'acct-1',
      snoozeRemindersUntil: '2026-09-25',
    })
  })

  it('derives tomorrow date in account timezone when snoozeUntilDate is omitted', async () => {
    const ctx = createContext()
    ctx.vault.getAccountRecord.mockResolvedValueOnce(storedAccount({
      account: 'acct-1',
      reminderTimezone: 'Australia/Sydney',
    }) as any)
    const caller = flockAccountsRouter.createCaller(ctx as any)

    const result = await caller.snoozeReminders({
      account: 'acct-1',
    })

    expect(result.success).toBe(true)
    expect(result.snoozeRemindersUntil).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(ctx.vault.updateAccountData).toHaveBeenCalledWith({
      account: 'acct-1',
      snoozeRemindersUntil: result.snoozeRemindersUntil,
    })
    expect(ctx.vault.getAccountRecord).toHaveBeenCalledTimes(1)
  })

  describe('single account read efficiency in protectedProcedure', () => {
    it('reads the account exactly once for addPushSubscription and merges existing subscriptions', async () => {
      const ctx = createContext()
      ctx.vault.getAccountRecord.mockResolvedValueOnce(storedAccount({
        account: 'acct-1',
        pushSubscriptions: [{ endpoint: endpoint('ep-1'), keys: { auth: 'a1', p256dh: 'p1' } }],
      }) as any)
      const caller = flockAccountsRouter.createCaller(ctx as any)

      const result = await caller.addPushSubscription({
        account: 'acct-1',
        endpoint: endpoint('ep-2'),
        keys: { auth: 'a2', p256dh: 'p2' },
      })

      expect(result).toEqual({ success: true })
      expect(ctx.vault.getAccountRecord).toHaveBeenCalledTimes(1)
      expect(ctx.vault.updateAccountData).toHaveBeenCalledWith({
        account: 'acct-1',
        pushSubscriptions: [
          { endpoint: endpoint('ep-1'), keys: { auth: 'a1', p256dh: 'p1' } },
          { endpoint: endpoint('ep-2'), keys: { auth: 'a2', p256dh: 'p2' } },
        ],
      })
    })

    it('reads the account exactly once for deletePushSubscription and filters existing subscriptions', async () => {
      const ctx = createContext()
      ctx.vault.getAccountRecord.mockResolvedValueOnce(storedAccount({
        account: 'acct-1',
        pushSubscriptions: [
          { endpoint: endpoint('ep-1'), keys: { auth: 'a1', p256dh: 'p1' } },
          { endpoint: endpoint('ep-2'), keys: { auth: 'a2', p256dh: 'p2' } },
        ],
      }) as any)
      const caller = flockAccountsRouter.createCaller(ctx as any)

      const result = await caller.deletePushSubscription({
        account: 'acct-1',
        endpoint: endpoint('ep-1'),
      })

      expect(result).toEqual({ success: true })
      expect(ctx.vault.getAccountRecord).toHaveBeenCalledTimes(1)
      expect(ctx.vault.updateAccountData).toHaveBeenCalledWith({
        account: 'acct-1',
        pushSubscriptions: [{ endpoint: endpoint('ep-2'), keys: { auth: 'a2', p256dh: 'p2' } }],
      })
    })

    it('reads the account exactly once for getReminderSettings', async () => {
      const ctx = createContext()
      ctx.vault.getAccountRecord.mockResolvedValueOnce(storedAccount({
        account: 'acct-1',
        reminderEnabled: true,
        reminderTime: '09:30',
        reminderTimezone: 'America/New_York',
        snoozeRemindersUntil: '2026-10-01',
      }) as any)
      const caller = flockAccountsRouter.createCaller(ctx as any)

      const result = await caller.getReminderSettings({ account: 'acct-1' })

      expect(result).toEqual({
        success: true,
        reminderEnabled: true,
        reminderTime: '09:30',
        reminderTimezone: 'America/New_York',
        snoozeRemindersUntil: '2026-10-01',
      })
      expect(ctx.vault.getAccountRecord).toHaveBeenCalledTimes(1)
    })
  })

  describe('addPushSubscription limits', () => {
    const keys = { auth: 'a', p256dh: 'p' }

    it.each([
      'http://fcm.googleapis.com/fcm/send/x',
      'https://169.254.169.254/latest/meta-data',
      'https://evil.example.com/fcm/send/x',
      'https://fcm.googleapis.com.evil.example.com/x',
      'https://fcm.googleapis.com:8443/fcm/send/x',
      'https://user:pass@fcm.googleapis.com/fcm/send/x',
      'not a url',
      `https://fcm.googleapis.com/fcm/send/${'x'.repeat(1024)}`,
    ])('rejects the endpoint %s', async badEndpoint => {
      const ctx = createContext()
      const caller = flockAccountsRouter.createCaller(ctx as any)

      await expect(caller.addPushSubscription({ account: 'acct-1', endpoint: badEndpoint, keys })).rejects.toThrow()
      expect(ctx.vault.updateAccountData).not.toHaveBeenCalled()
    })

    it('rejects oversized keys', async () => {
      const ctx = createContext()
      const caller = flockAccountsRouter.createCaller(ctx as any)

      await expect(caller.addPushSubscription({
        account: 'acct-1',
        endpoint: endpoint('x'),
        keys: { auth: 'a', p256dh: 'p'.repeat(129) },
      })).rejects.toThrow()
      expect(ctx.vault.updateAccountData).not.toHaveBeenCalled()
    })

    it.each([
      'https://updates.push.services.mozilla.com/wpush/v2/x',
      'https://web.push.apple.com/x',
      'https://wns2-par02p.notify.windows.com/w/?token=x',
    ])('accepts the push service endpoint %s', async goodEndpoint => {
      const ctx = createContext()
      const caller = flockAccountsRouter.createCaller(ctx as any)

      await expect(caller.addPushSubscription({ account: 'acct-1', endpoint: goodEndpoint, keys })).resolves.toEqual({ success: true })
    })

    it('keeps only the newest 10 subscriptions', async () => {
      const ctx = createContext()
      const existing = Array.from({ length: 10 }, (_, i) => ({ endpoint: endpoint(`old-${i}`), keys }))
      ctx.vault.getAccountRecord.mockResolvedValueOnce(storedAccount({ pushSubscriptions: existing }) as any)
      const caller = flockAccountsRouter.createCaller(ctx as any)

      await caller.addPushSubscription({ account: 'acct-1', endpoint: endpoint('new'), keys })

      expect(ctx.vault.updateAccountData).toHaveBeenCalledWith({
        account: 'acct-1',
        pushSubscriptions: [...existing.slice(1), { endpoint: endpoint('new'), keys }],
      })
    })
  })

  describe('updateReminderSettings', () => {
    const settings = { account: 'acct-1', reminderTime: '07:30', reminderTimezone: 'Australia/Sydney' }

    it('puts the account in the reminder index when reminders are turned on', async () => {
      const ctx = createContext()
      const caller = flockAccountsRouter.createCaller(ctx as any)

      await caller.updateReminderSettings({ ...settings, reminderEnabled: true })

      expect(ctx.vault.updateAccountData).toHaveBeenCalledWith({
        ...settings,
        reminderEnabled: true,
        reminderIndex: 'on',
      })
    })

    it('takes the account out of the index when reminders are turned off', async () => {
      const ctx = createContext()
      const caller = flockAccountsRouter.createCaller(ctx as any)

      await caller.updateReminderSettings({ ...settings, reminderEnabled: false })

      expect(ctx.vault.updateAccountData).toHaveBeenCalledWith({
        ...settings,
        reminderEnabled: false,
        remove: ['reminderIndex'],
      })
    })
  })
})

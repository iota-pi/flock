import { flockAccountsRouter } from './flockAccounts'
import { hashSessionToken, SESSION_EXPIRY_MS } from '@vault/server'

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
    getNewAccountId: vi.fn(async () => 'acct-1'),
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
        pushSubscriptions: [{ endpoint: 'ep-1', keys: { auth: 'a1', p256dh: 'p1' } }],
      }) as any)
      const caller = flockAccountsRouter.createCaller(ctx as any)

      const result = await caller.addPushSubscription({
        account: 'acct-1',
        endpoint: 'ep-2',
        keys: { auth: 'a2', p256dh: 'p2' },
      })

      expect(result).toEqual({ success: true })
      expect(ctx.vault.getAccountRecord).toHaveBeenCalledTimes(1)
      expect(ctx.vault.updateAccountData).toHaveBeenCalledWith({
        account: 'acct-1',
        pushSubscriptions: [
          { endpoint: 'ep-1', keys: { auth: 'a1', p256dh: 'p1' } },
          { endpoint: 'ep-2', keys: { auth: 'a2', p256dh: 'p2' } },
        ],
      })
    })

    it('reads the account exactly once for deletePushSubscription and filters existing subscriptions', async () => {
      const ctx = createContext()
      ctx.vault.getAccountRecord.mockResolvedValueOnce(storedAccount({
        account: 'acct-1',
        pushSubscriptions: [
          { endpoint: 'ep-1', keys: { auth: 'a1', p256dh: 'p1' } },
          { endpoint: 'ep-2', keys: { auth: 'a2', p256dh: 'p2' } },
        ],
      }) as any)
      const caller = flockAccountsRouter.createCaller(ctx as any)

      const result = await caller.deletePushSubscription({
        account: 'acct-1',
        endpoint: 'ep-1',
      })

      expect(result).toEqual({ success: true })
      expect(ctx.vault.getAccountRecord).toHaveBeenCalledTimes(1)
      expect(ctx.vault.updateAccountData).toHaveBeenCalledWith({
        account: 'acct-1',
        pushSubscriptions: [{ endpoint: 'ep-2', keys: { auth: 'a2', p256dh: 'p2' } }],
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
})

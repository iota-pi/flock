import { flockAccountsRouter } from './flockAccounts'


function createContext(overrides?: { authToken?: string, sessionValid?: boolean }) {
  const sessionValid = overrides?.sessionValid ?? true
  const vault = {
    getNewAccountId: vi.fn(async () => 'acct-1'),
    createAccount: vi.fn(async () => true),
    updateAccountData: vi.fn(async () => undefined),
    getAccountSalt: vi.fn(async () => 'salt-1'),
    getAccount: vi.fn(async () => {
      if (!sessionValid) {
        throw new Error('Unauthorized')
      }
      return { metadata: { theme: 'light' } }
    }),
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
    ctx.vault.getAccount.mockResolvedValueOnce({
      account: 'acct-1',
      reminderTimezone: 'Australia/Sydney',
    } as any)
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
    expect(ctx.vault.getAccount).toHaveBeenCalledTimes(1)
  })

  describe('single getAccount round-trip efficiency in protectedProcedure', () => {
    it('calls getAccount exactly once for addPushSubscription and merges existing subscriptions', async () => {
      const ctx = createContext()
      ctx.vault.getAccount.mockResolvedValueOnce({
        account: 'acct-1',
        pushSubscriptions: [{ endpoint: 'ep-1', keys: { auth: 'a1', p256dh: 'p1' } }],
      } as any)
      const caller = flockAccountsRouter.createCaller(ctx as any)

      const result = await caller.addPushSubscription({
        account: 'acct-1',
        endpoint: 'ep-2',
        keys: { auth: 'a2', p256dh: 'p2' },
      })

      expect(result).toEqual({ success: true })
      expect(ctx.vault.getAccount).toHaveBeenCalledTimes(1)
      expect(ctx.vault.updateAccountData).toHaveBeenCalledWith({
        account: 'acct-1',
        pushSubscriptions: [
          { endpoint: 'ep-1', keys: { auth: 'a1', p256dh: 'p1' } },
          { endpoint: 'ep-2', keys: { auth: 'a2', p256dh: 'p2' } },
        ],
      })
    })

    it('calls getAccount exactly once for deletePushSubscription and filters existing subscriptions', async () => {
      const ctx = createContext()
      ctx.vault.getAccount.mockResolvedValueOnce({
        account: 'acct-1',
        pushSubscriptions: [
          { endpoint: 'ep-1', keys: { auth: 'a1', p256dh: 'p1' } },
          { endpoint: 'ep-2', keys: { auth: 'a2', p256dh: 'p2' } },
        ],
      } as any)
      const caller = flockAccountsRouter.createCaller(ctx as any)

      const result = await caller.deletePushSubscription({
        account: 'acct-1',
        endpoint: 'ep-1',
      })

      expect(result).toEqual({ success: true })
      expect(ctx.vault.getAccount).toHaveBeenCalledTimes(1)
      expect(ctx.vault.updateAccountData).toHaveBeenCalledWith({
        account: 'acct-1',
        pushSubscriptions: [{ endpoint: 'ep-2', keys: { auth: 'a2', p256dh: 'p2' } }],
      })
    })

    it('calls getAccount exactly once for getReminderSettings', async () => {
      const ctx = createContext()
      ctx.vault.getAccount.mockResolvedValueOnce({
        account: 'acct-1',
        reminderEnabled: true,
        reminderTime: '09:30',
        reminderTimezone: 'America/New_York',
        snoozeRemindersUntil: '2026-10-01',
      } as any)
      const caller = flockAccountsRouter.createCaller(ctx as any)

      const result = await caller.getReminderSettings({ account: 'acct-1' })

      expect(result).toEqual({
        success: true,
        reminderEnabled: true,
        reminderTime: '09:30',
        reminderTimezone: 'America/New_York',
        snoozeRemindersUntil: '2026-10-01',
      })
      expect(ctx.vault.getAccount).toHaveBeenCalledTimes(1)
    })
  })
})

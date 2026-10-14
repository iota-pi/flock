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

  describe('legacy plaintext metadata', () => {
    it('returns the stored legacy metadata', async () => {
      const ctx = createContext()
      const caller = flockAccountsRouter.createCaller(ctx as any)

      const result = await caller.getMetadata({ account: 'acct-1' })

      expect(result).toEqual({ success: true, metadata: { theme: 'light' } })
      expect(ctx.vault.getAccount).toHaveBeenCalledTimes(1)
    })

    it('returns empty metadata for accounts without any', async () => {
      const ctx = createContext()
      ctx.vault.getAccount.mockResolvedValueOnce({ account: 'acct-1' } as any)
      const caller = flockAccountsRouter.createCaller(ctx as any)

      const result = await caller.getMetadata({ account: 'acct-1' })

      expect(result).toEqual({ success: true, metadata: {} })
    })

    it('blocks metadata access without a valid session', async () => {
      const missingToken = flockAccountsRouter.createCaller(createContext({ authToken: '' }) as any)
      const invalidSession = flockAccountsRouter.createCaller(createContext({ sessionValid: false }) as any)

      await expect(missingToken.getMetadata({ account: 'acct-1' })).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
      await expect(invalidSession.getMetadata({ account: 'acct-1' })).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    })

    it('discards metadata pushed by cached clients instead of storing it', async () => {
      const ctx = createContext()
      const caller = flockAccountsRouter.createCaller(ctx as any)

      const result = await caller.updateMetadata({ account: 'acct-1', metadata: { prayerGoal: 10 } })

      expect(result).toEqual({ success: true })
      expect(ctx.vault.updateAccountData).not.toHaveBeenCalled()
    })

    it('rejects invalid metadata from cached clients', async () => {
      const caller = flockAccountsRouter.createCaller(createContext() as any)

      await expect(caller.updateMetadata({
        account: 'acct-1',
        metadata: 'invalid-metadata' as unknown as Record<string, unknown>,
      })).rejects.toBeDefined()
    })

    it('clears the stored metadata', async () => {
      const ctx = createContext()
      const caller = flockAccountsRouter.createCaller(ctx as any)

      const result = await caller.clearMetadata({ account: 'acct-1' })

      expect(result).toEqual({ success: true })
      expect(ctx.vault.updateAccountData).toHaveBeenCalledWith({ account: 'acct-1', metadata: {} })
    })

    it('blocks clearing metadata without a valid session', async () => {
      const ctx = createContext({ sessionValid: false })
      const caller = flockAccountsRouter.createCaller(ctx as any)

      await expect(caller.clearMetadata({ account: 'acct-1' })).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
      expect(ctx.vault.updateAccountData).not.toHaveBeenCalled()
    })
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

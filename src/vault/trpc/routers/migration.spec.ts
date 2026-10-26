import { hashSessionToken, SESSION_EXPIRY_MS } from '@vault/server'
import { migrationRouter } from './migration'

function createContext() {
  const vault = {
    updateAccountData: vi.fn(async () => undefined),
    getAccountRecord: vi.fn(async () => ({
      metadata: { prayerGoal: 5 },
      sessions: [{ token: hashSessionToken('session-token'), expiry: Date.now() + SESSION_EXPIRY_MS }],
    })),
    extendSession: vi.fn(async () => undefined),
  }
  return { authToken: 'session-token', vault }
}

describe('migrationRouter', () => {
  it('returns the legacy plaintext settings', async () => {
    const ctx = createContext()
    const caller = migrationRouter.createCaller(ctx as any)

    await expect(caller.getLegacySettings({ account: 'acct-1' })).resolves.toEqual({
      success: true,
      metadata: { prayerGoal: 5 },
    })
  })

  it('clears the legacy plaintext settings', async () => {
    const ctx = createContext()
    const caller = migrationRouter.createCaller(ctx as any)

    await expect(caller.clearLegacySettings({ account: 'acct-1' })).resolves.toEqual({ success: true })
    expect(ctx.vault.updateAccountData).toHaveBeenCalledWith({ account: 'acct-1', metadata: {} })
  })
})

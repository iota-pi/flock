import { FAILED_LOGIN_WINDOW_MS, isLoginLocked, MAX_FAILED_LOGINS } from './loginThrottle'

describe('isLoginLocked', () => {
  const now = 1_000_000_000

  it('locks an account with too many failures within the window', () => {
    expect(isLoginLocked({ failedLogins: MAX_FAILED_LOGINS, failedLoginsSince: now - 1000 }, now)).toBe(true)
  })

  it('leaves an account with fewer failures unlocked', () => {
    expect(isLoginLocked({ failedLogins: MAX_FAILED_LOGINS - 1, failedLoginsSince: now - 1000 }, now)).toBe(false)
    expect(isLoginLocked({}, now)).toBe(false)
  })

  it('unlocks once the window has passed', () => {
    expect(isLoginLocked({
      failedLogins: MAX_FAILED_LOGINS,
      failedLoginsSince: now - FAILED_LOGIN_WINDOW_MS,
    }, now)).toBe(false)
  })
})

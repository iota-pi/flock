import { authenticateLogin, authenticateSession } from './authentication'
import { AuthenticationError, ExpiredSessionError, TooManyLoginAttemptsError } from './errors'
import { MAX_FAILED_LOGINS } from './loginThrottle'
import { hashSessionToken, SESSION_EXPIRY_MS } from './sessions'

const now = 1_800_000_000_000

function storedAccount(fields: Record<string, unknown> = {}) {
  return { account: 'acct-1', authToken: 'stored-hash', salt: 'salt', ...fields }
}

describe('authenticateLogin', () => {
  it('accepts the stored auth token hash', () => {
    expect(authenticateLogin(storedAccount(), 'stored-hash', now)).toMatchObject({
      account: 'acct-1',
      session: 'stored-hash',
    })
  })

  it('rejects a wrong hash, an empty one and a missing account alike', () => {
    expect(() => authenticateLogin(storedAccount(), 'wrong-hash', now)).toThrow(AuthenticationError)
    expect(() => authenticateLogin(storedAccount(), '', now)).toThrow(AuthenticationError)
    expect(() => authenticateLogin(undefined, 'stored-hash', now)).toThrow(AuthenticationError)
  })

  it('refuses a locked account before checking the hash', () => {
    const locked = storedAccount({ failedLogins: MAX_FAILED_LOGINS, failedLoginsSince: now - 1000 })
    expect(() => authenticateLogin(locked, 'stored-hash', now)).toThrow(TooManyLoginAttemptsError)
    expect(() => authenticateLogin(locked, 'wrong-hash', now)).toThrow(TooManyLoginAttemptsError)
  })
})

describe('authenticateSession', () => {
  const session = 'session-token'
  const active = { token: hashSessionToken(session), expiry: now + SESSION_EXPIRY_MS }

  it('accepts an active session and returns only the active sessions', () => {
    const expired = { token: hashSessionToken('old'), expiry: now - 1 }
    const result = authenticateSession(storedAccount({ sessions: [expired, active] }), session, now)
    expect(result).toMatchObject({ account: 'acct-1', session, sessions: [active] })
  })

  it('rejects an expired or unknown session', () => {
    const expired = { token: hashSessionToken(session), expiry: now - 1 }
    expect(() => authenticateSession(storedAccount({ sessions: [expired] }), session, now)).toThrow(ExpiredSessionError)
    expect(() => authenticateSession(storedAccount({ sessions: [active] }), 'other', now)).toThrow(ExpiredSessionError)
  })

  it('rejects a missing account or an empty token', () => {
    expect(() => authenticateSession(undefined, session, now)).toThrow(AuthenticationError)
    expect(() => authenticateSession(storedAccount({ sessions: [active] }), '', now)).toThrow(AuthenticationError)
  })

  it('does not accept the auth token hash as a session', () => {
    expect(() => authenticateSession(storedAccount({ sessions: [active] }), 'stored-hash', now)).toThrow(ExpiredSessionError)
  })
})

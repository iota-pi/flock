import { authenticateLogin, authenticateSession } from './authentication'
import { AuthenticationError, ExpiredSessionError, TooManyLoginAttemptsError } from './errors'
import { hashSessionToken, SESSION_EXPIRY_MS } from './sessions'

const now = 1_800_000_000_000

function storedAccount(fields: Record<string, unknown> = {}) {
  return { account: 'acct-1', authToken: 'stored-hash', salt: 'salt', ...fields }
}

describe('authenticateLogin', () => {
  const unlocked = false
  const locked = true
  const withDevice = storedAccount({ loginDevices: ['other-device', 'device-hash'] })

  it('accepts the stored auth token hash', () => {
    expect(() => authenticateLogin(storedAccount(), unlocked, { authTokenHash: 'stored-hash' })).not.toThrow()
  })

  it('rejects a wrong hash, an empty one and a missing account alike', () => {
    expect(() => authenticateLogin(storedAccount(), unlocked, { authTokenHash: 'wrong-hash' })).toThrow(AuthenticationError)
    expect(() => authenticateLogin(storedAccount(), unlocked, { authTokenHash: '' })).toThrow(AuthenticationError)
    expect(() => authenticateLogin(undefined, unlocked, { authTokenHash: 'stored-hash' })).toThrow(AuthenticationError)
  })

  it('refuses a locked ID whatever the hash, and whether or not the account exists', () => {
    expect(() => authenticateLogin(storedAccount(), locked, { authTokenHash: 'stored-hash' })).toThrow(TooManyLoginAttemptsError)
    expect(() => authenticateLogin(storedAccount(), locked, { authTokenHash: 'wrong-hash' })).toThrow(TooManyLoginAttemptsError)
    expect(() => authenticateLogin(undefined, locked, { authTokenHash: 'stored-hash' })).toThrow(TooManyLoginAttemptsError)
  })

  it('lets a login device with the right hash through a lock', () => {
    expect(() => authenticateLogin(withDevice, locked, { authTokenHash: 'stored-hash', deviceHash: 'device-hash' }))
      .not.toThrow()
  })

  it('refuses a login device with the wrong hash, and an unknown device with the right one, while locked', () => {
    expect(() => authenticateLogin(withDevice, locked, { authTokenHash: 'wrong-hash', deviceHash: 'device-hash' }))
      .toThrow(TooManyLoginAttemptsError)
    expect(() => authenticateLogin(withDevice, locked, { authTokenHash: 'stored-hash', deviceHash: 'new-device' }))
      .toThrow(TooManyLoginAttemptsError)
    expect(() => authenticateLogin(withDevice, locked, { authTokenHash: 'stored-hash' }))
      .toThrow(TooManyLoginAttemptsError)
  })

  it('rejects a login device with the wrong hash when not locked', () => {
    expect(() => authenticateLogin(withDevice, unlocked, { authTokenHash: 'wrong-hash', deviceHash: 'device-hash' }))
      .toThrow(AuthenticationError)
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

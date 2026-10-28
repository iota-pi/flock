import {
  addSessionRecord,
  findSession,
  hashSessionToken,
  MAX_ACTIVE_SESSIONS,
  normalizeSessionRecords,
  renewSessionRecord,
  SESSION_CLOCK_SKEW_MS,
  SESSION_EXPIRY_MS,
  SESSION_RENEWAL_THRESHOLD_MS,
  shouldRenewSession,
} from './sessions'
import type { VaultSessionRecord } from './drivers/vaultDriver'

const now = 1_800_000_000_000

describe('normalizeSessionRecords', () => {
  it('keeps unexpired, well-formed sessions', () => {
    const active = { token: 'a', expiry: now + 1000 }
    expect(normalizeSessionRecords([
      active,
      { token: 'expired', expiry: now },
      { token: '', expiry: now + 1000 },
      { token: 'no-expiry' },
      null,
    ], now)).toEqual([active])
    expect(normalizeSessionRecords(undefined, now)).toEqual([])
  })

  it('drops sessions issued under a longer lifetime', () => {
    const tooLong = { token: 'long', expiry: now + SESSION_EXPIRY_MS + SESSION_CLOCK_SKEW_MS + 1 }
    const withinSkew = { token: 'skew', expiry: now + SESSION_EXPIRY_MS + SESSION_CLOCK_SKEW_MS }
    expect(normalizeSessionRecords([tooLong, withinSkew], now)).toEqual([withinSkew])
  })

  it('deduplicates tokens and keeps the sessions that expire last', () => {
    const sessions = Array.from({ length: MAX_ACTIVE_SESSIONS + 2 }, (_, i) => ({ token: `t${i}`, expiry: now + 1000 + i }))
    const result = normalizeSessionRecords([...sessions, sessions[sessions.length - 1]], now)
    expect(result).toEqual(sessions.slice(-MAX_ACTIVE_SESSIONS))
  })
})

describe('addSessionRecord', () => {
  it('adds a hashed record', () => {
    const existing = { token: 'other', expiry: now + 1000 }
    expect(addSessionRecord([existing], 'token', now + 5000)).toEqual([
      existing,
      { token: hashSessionToken('token'), expiry: now + 5000 },
    ])
  })
})

describe('findSession', () => {
  it('finds the hashed record for the token', () => {
    const recordA = { token: hashSessionToken('token-a'), expiry: now + 1 }
    const recordB = { token: hashSessionToken('token-b'), expiry: now + 2 }

    expect(findSession([recordA, recordB], 'token-a')).toBe(recordA)
    expect(findSession([recordA, recordB], 'token-b')).toBe(recordB)
  })

  it('does not accept a record holding the raw token', () => {
    expect(findSession([{ token: 'token-a', expiry: now + 1 }], 'token-a')).toBeUndefined()
  })

  it('returns undefined without a matching record', () => {
    expect(findSession([{ token: hashSessionToken('token-a'), expiry: now }], 'token-c')).toBeUndefined()
    expect(findSession(undefined, 'token-a')).toBeUndefined()
  })
})

describe('renewSessionRecord', () => {
  const other = { token: hashSessionToken('other'), expiry: now + 1000 }

  it('gives the session a full lifetime without changing the others', () => {
    const sessions = [other, { token: hashSessionToken('token'), expiry: now + 1000 }]
    expect(renewSessionRecord(sessions, 'token', now, false)).toEqual([
      other,
      { token: hashSessionToken('token'), expiry: now + SESSION_EXPIRY_MS },
    ])
    expect(sessions[1].expiry).toBe(now + 1000)
  })

  it('leaves the sessions alone without a matching one, or on a retry after a concurrent renewal', () => {
    expect(renewSessionRecord([other], 'token', now, false)).toBeUndefined()
    const justRenewed = [{ token: hashSessionToken('token'), expiry: now + SESSION_EXPIRY_MS }]
    expect(renewSessionRecord(justRenewed, 'token', now, true)).toBeUndefined()
  })
})

describe('shouldRenewSession', () => {
  const authToken = 'test-token-123'

  it('returns false when session was renewed recently (> 48 hours remaining)', () => {
    const accountData = {
      sessions: [
        {
          token: hashSessionToken(authToken),
          expiry: now + SESSION_EXPIRY_MS, // exactly 72 hours remaining
        },
      ],
    }

    expect(shouldRenewSession(accountData, authToken, now)).toBe(false)
  })

  it('returns false when exactly at 48 hours remaining', () => {
    const accountData = {
      sessions: [
        {
          token: hashSessionToken(authToken),
          expiry: now + SESSION_RENEWAL_THRESHOLD_MS, // exactly 48 hours remaining
        },
      ],
    }

    expect(shouldRenewSession(accountData, authToken, now)).toBe(false)
  })

  it('returns true when session has aged past threshold (< 48 hours remaining)', () => {
    const accountData = {
      sessions: [
        {
          token: hashSessionToken(authToken),
          expiry: now + SESSION_RENEWAL_THRESHOLD_MS - 1000, // just under 48 hours remaining
        },
      ],
    }

    expect(shouldRenewSession(accountData, authToken, now)).toBe(true)
  })

  it('returns true when session is nearing expiry (e.g. 1 hour remaining)', () => {
    const accountData = {
      sessions: [
        {
          token: hashSessionToken(authToken),
          expiry: now + 3600_000,
        },
      ],
    }

    expect(shouldRenewSession(accountData, authToken, now)).toBe(true)
  })

  it('returns true when sessions array is missing or empty', () => {
    const accountDataWithoutSessions = {}
    expect(shouldRenewSession(accountDataWithoutSessions, authToken, now)).toBe(true)

    const accountDataWithEmptySessions = { sessions: [] as VaultSessionRecord[] }
    expect(shouldRenewSession(accountDataWithEmptySessions, authToken, now)).toBe(true)
  })

  it('returns true when session token does not match', () => {
    const accountData = {
      sessions: [
        {
          token: 'different-token',
          expiry: now + SESSION_EXPIRY_MS,
        },
      ],
    }

    expect(shouldRenewSession(accountData, authToken, now)).toBe(true)
  })

  it('finds a session stored as its hash', () => {
    const accountData = {
      sessions: [{ token: hashSessionToken(authToken), expiry: now + SESSION_EXPIRY_MS }],
    }

    expect(shouldRenewSession(accountData, authToken, now)).toBe(false)
  })
})

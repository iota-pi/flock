import {
  addSessionRecord,
  hashSessionToken,
  isSessionFor,
  MAX_ACTIVE_SESSIONS,
  normalizeSessionRecords,
  renewSessionRecord,
  SESSION_CLOCK_SKEW_MS,
  SESSION_EXPIRY_MS,
} from './sessions'

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

  it('rewrites a record from before tokens were hashed', () => {
    const renewed = renewSessionRecord([{ token: 'legacy', expiry: now + SESSION_EXPIRY_MS }], 'legacy', now, false)
    expect(renewed).toEqual([{ token: hashSessionToken('legacy'), expiry: now + SESSION_EXPIRY_MS }])
    expect(isSessionFor(renewed![0], 'legacy')).toBe(true)
  })

  it('leaves the sessions alone without a matching one, or on a retry after a concurrent renewal', () => {
    expect(renewSessionRecord([other], 'token', now, false)).toBeUndefined()
    const justRenewed = [{ token: hashSessionToken('token'), expiry: now + SESSION_EXPIRY_MS }]
    expect(renewSessionRecord(justRenewed, 'token', now, true)).toBeUndefined()
  })
})

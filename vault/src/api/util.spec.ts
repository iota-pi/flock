import { getAuthToken, hashString } from './util'

describe('vault api util', () => {
  it('hashString produces consistent base64 output', () => {
    const a = hashString('hello')
    const b = hashString('hello')
    expect(typeof a).toBe('string')
    expect(a).toBe(b)
    expect(a.length).toBeGreaterThan(0)
  })

  it('getAuthToken strips scheme and hashes token', () => {
    const req: any = { headers: { authorization: 'Bearer mytoken' } }
    const expected = hashString('mytoken')
    expect(getAuthToken(req)).toBe(expected)
  })

  it('getAuthToken handles other scheme names and case-insensitive', () => {
    const req1: any = { headers: { authorization: 'Token abc123' } }
    const req2: any = { headers: { authorization: 'token abc123' } }
    const expected = hashString('abc123')
    expect(getAuthToken(req1)).toBe(expected)
    expect(getAuthToken(req2)).toBe(expected)
  })

  it('getAuthToken returns hash of empty string when no header present', () => {
    const req: any = { headers: {} }
    expect(getAuthToken(req)).toBe(hashString(''))
  })
})

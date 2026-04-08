import { getAuthToken, hashString } from './util'

describe('vault api util', () => {
  it('hashString produces consistent base64 output', () => {
    const a = hashString('hello')
    const b = hashString('hello')
    expect(typeof a).toBe('string')
    expect(a).toBe(b)
    expect(a.length).toBeGreaterThan(0)
  })

  it('getAuthToken strips scheme and returns token', () => {
    const req: any = { headers: { authorization: 'Bearer mytoken' } }
    expect(getAuthToken(req)).toBe('mytoken')
  })

  it('getAuthToken handles other scheme names and case-insensitive', () => {
    const req1: any = { headers: { authorization: 'Token abc123' } }
    const req2: any = { headers: { authorization: 'token abc123' } }
    expect(getAuthToken(req1)).toBe('abc123')
    expect(getAuthToken(req2)).toBe('abc123')
  })

  it('getAuthToken returns empty string when no header present', () => {
    const req: any = { headers: {} }
    expect(getAuthToken(req)).toBe('')
  })
})

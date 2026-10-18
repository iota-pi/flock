import { fakeSalt, generateAccountId, hashString } from './util'

describe('vault util', () => {
  it('hashString produces consistent base64 output', () => {
    const a = hashString('hello')
    const b = hashString('hello')
    expect(typeof a).toBe('string')
    expect(a).toBe(b)
    expect(a.length).toBeGreaterThan(0)
  })

  describe('generateAccountId', () => {
    it('returns a 4-character alphanumeric lowercase id', () => {
      const id = generateAccountId()
      expect(typeof id).toBe('string')
      expect(id.length).toBe(4)
      expect(id).toMatch(/^[a-z0-9]{4}$/)
    })

    it('generates mostly-unique ids across multiple calls', () => {
      const ids = new Set<string>()
      for (let i = 0; i < 1000; i += 1) {
        ids.add(generateAccountId())
      }
      // Not asserting perfect uniqueness (birthday paradox), but ensure collisions are not extreme
      expect(ids.size).toBeGreaterThan(900)
    })

    it('always returns 4 characters', () => {
      for (let i = 0; i < 1000; i += 1) {
        expect(generateAccountId()).toMatch(/^[a-z0-9]{4}$/)
      }
    })
  })

  describe('fakeSalt', () => {
    it('is stable per account and secret, and shaped like a 16-byte salt', () => {
      const salt = fakeSalt('abcd', 'secret')
      expect(fakeSalt('abcd', 'secret')).toBe(salt)
      expect(Buffer.from(salt, 'base64')).toHaveLength(16)
      expect(fakeSalt('abce', 'secret')).not.toBe(salt)
      expect(fakeSalt('abcd', 'other-secret')).not.toBe(salt)
    })
  })
})

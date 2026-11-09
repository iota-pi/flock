import { isValidNewAccountId } from '@vault/shared'
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
    it('returns a canonical current-format id', () => {
      const id = generateAccountId()
      expect(id).toHaveLength(8)
      expect(isValidNewAccountId(id)).toBe(true)
    })

    it('generates mostly-unique ids across multiple calls', () => {
      const ids = new Set<string>()
      for (let i = 0; i < 1000; i += 1) {
        ids.add(generateAccountId())
      }
      // Not asserting perfect uniqueness (birthday paradox), but ensure collisions are not extreme
      expect(ids.size).toBeGreaterThan(990)
    })

    it('always returns a valid id', () => {
      for (let i = 0; i < 1000; i += 1) {
        expect(isValidNewAccountId(generateAccountId())).toBe(true)
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

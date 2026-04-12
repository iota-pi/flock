import { generateAccountId } from './util'

describe('vault util', () => {
  describe('generateAccountId', () => {
    it('returns a 4-character alphanumeric lowercase id', () => {
      const id = generateAccountId()
      expect(typeof id).toBe('string')
      expect(id.length).toBe(4)
      expect(id).toMatch(/^[a-z0-9]{4}$/)
    })

    it('generates mostly-unique ids across multiple calls', () => {
      const ids = new Set<string>()
      for (let i = 0; i < 1000; i++) {
        ids.add(generateAccountId())
      }
      // Not asserting perfect uniqueness (birthday paradox), but ensure collisions are not extreme
      expect(ids.size).toBeGreaterThan(900)
    })
  })
})

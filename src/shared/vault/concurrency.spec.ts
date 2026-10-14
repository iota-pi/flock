import { mapWithConcurrency, resolveConcurrency, DEFAULT_CONCURRENCY } from './concurrency'

describe('concurrency utilities', () => {
  describe('resolveConcurrency', () => {
    it('returns positive integer when valid number provided', () => {
      expect(resolveConcurrency(5)).toBe(5)
      expect(resolveConcurrency(3.7)).toBe(3)
    })

    it('returns default fallback when non-positive or non-number provided', () => {
      expect(resolveConcurrency(undefined)).toBe(DEFAULT_CONCURRENCY)
      expect(resolveConcurrency(0)).toBe(DEFAULT_CONCURRENCY)
      expect(resolveConcurrency(-1)).toBe(DEFAULT_CONCURRENCY)
      expect(resolveConcurrency(NaN)).toBe(DEFAULT_CONCURRENCY)
      expect(resolveConcurrency(undefined, 20)).toBe(20)
    })
  })

  describe('mapWithConcurrency', () => {
    it('returns empty array when input is empty', async () => {
      const fn = vi.fn()
      const result = await mapWithConcurrency([], 5, fn)
      expect(result).toEqual([])
      expect(fn).not.toHaveBeenCalled()
    })

    it('processes all items when concurrency is larger than item count', async () => {
      const result = await mapWithConcurrency([1, 2, 3], 10, async x => x * 2)
      expect(result).toEqual([2, 4, 6])
    })

    it('works correctly with concurrency = 1 (strictly serial)', async () => {
      const callLog: number[] = []
      const result = await mapWithConcurrency([1, 2, 3], 1, async x => {
        callLog.push(x)
        return x * 10
      })
      expect(callLog).toEqual([1, 2, 3])
      expect(result).toEqual([10, 20, 30])
    })

    it('limits peak active concurrent workers to concurrency limit', async () => {
      let active = 0
      let peak = 0
      const items = Array.from({ length: 20 }, (_, i) => i)

      const result = await mapWithConcurrency(items, 4, async x => {
        active += 1
        peak = Math.max(peak, active)
        await new Promise(resolve => setTimeout(resolve, 10))
        active -= 1
        return x * 2
      })

      expect(peak).toBe(4)
      expect(result).toEqual(items.map(x => x * 2))
    })

    it('preserves ordering even when completion finishes out of order', async () => {
      const items = [10, 30, 5, 20]
      const result = await mapWithConcurrency(items, 3, async delay => {
        await new Promise(resolve => setTimeout(resolve, delay))
        return delay * 2
      })
      expect(result).toEqual([20, 60, 10, 40])
    })

    it('halts processing and throws first error if a worker fails', async () => {
      const executed: number[] = []
      const items = Array.from({ length: 15 }, (_, i) => i)

      await expect(
        mapWithConcurrency(items, 2, async x => {
          executed.push(x)
          if (x === 2) {
            throw new Error('Failure on item 2')
          }
          await new Promise(resolve => setTimeout(resolve, 15))
          return x
        }),
      ).rejects.toThrow('Failure on item 2')

      // Should not have processed all 15 items
      expect(executed.length).toBeLessThan(15)
    })
  })
})

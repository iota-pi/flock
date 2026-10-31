import { chunk, mapWithConcurrency } from './concurrency'

describe('concurrency utilities', () => {
  describe('chunk', () => {
    it('returns no chunks for an empty array', () => {
      expect(chunk([], 3)).toEqual([])
    })

    it('splits evenly divisible input into full chunks', () => {
      expect(chunk([1, 2, 3, 4], 2)).toEqual([[1, 2], [3, 4]])
    })

    it('puts the remainder in a smaller last chunk', () => {
      expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
    })

    it('returns a single chunk when size exceeds the length', () => {
      expect(chunk([1, 2], 5)).toEqual([[1, 2]])
    })

    it('does not modify the input', () => {
      const items = [1, 2, 3]
      chunk(items, 2)
      expect(items).toEqual([1, 2, 3])
    })

    it('rejects sizes that are not positive integers', () => {
      expect(() => chunk([1], 0)).toThrow(RangeError)
      expect(() => chunk([1], -1)).toThrow(RangeError)
      expect(() => chunk([1], 1.5)).toThrow(RangeError)
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

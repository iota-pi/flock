/**
 * Concurrency utilities for bounding parallel asynchronous operations.
 */

/**
 * Maps an array of items asynchronously with bounded concurrency.
 * Preserves input array ordering in the returned results array.
 * Halts processing remaining items and throws the first error if any worker fails.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) {
    return []
  }

  const workerCount = Math.max(1, Math.min(concurrency, items.length))
  const results = new Array<R>(items.length)
  let currentIndex = 0
  let firstError: unknown = null
  let hasError = false

  const workers = Array.from({ length: workerCount }, async () => {
    while (currentIndex < items.length && !hasError) {
      const index = currentIndex
      currentIndex += 1
      try {
        results[index] = await fn(items[index])
      } catch (err) {
        if (!hasError) {
          hasError = true
          firstError = err
        }
        break
      }
    }
  })

  await Promise.all(workers)

  if (hasError) {
    throw firstError
  }

  return results
}

/**
 * Splits items into consecutive groups of `size` (the last group may be smaller).
 * Throws if `size` is not a positive integer.
 */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size < 1) {
    throw new RangeError(`chunk size must be a positive integer, got ${size}`)
  }
  const chunks: T[][] = []
  for (let start = 0; start < items.length; start += size) {
    chunks.push(items.slice(start, start + size))
  }
  return chunks
}

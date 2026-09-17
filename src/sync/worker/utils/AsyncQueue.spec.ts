import { describe, it, expect, vi } from 'vitest'
import { AsyncQueue } from './AsyncQueue'

describe('AsyncQueue', () => {
  it('processes items sequentially in FIFO order', async () => {
    const executed: number[] = []
    const queue = new AsyncQueue<number>(async item => {
      await new Promise(resolve => setTimeout(resolve, 10))
      executed.push(item)
    })

    queue.push(1, 2, 3)
    await queue.whenIdle()

    expect(executed).toEqual([1, 2, 3])
  })

  it('provides array-like inspection and index access', () => {
    const queue = new AsyncQueue<string>(() => {})
    expect(queue.length).toBe(0)
    expect(queue.size).toBe(0)
    expect(queue.isEmpty).toBe(true)
    expect(queue[0]).toBeUndefined()
    expect(queue.peek()).toBeUndefined()
    expect(queue.at(0)).toBeUndefined()

    // Note: queue.push triggers drain synchronously until first await.
    // If worker is sync, it completes immediately.
  })

  it('retains head item while active and shifts after completion', async () => {
    let releaseWorker!: () => void
    const workerPromise = new Promise<void>(resolve => {
      releaseWorker = resolve
    })

    const queue = new AsyncQueue<{ id: string; retries: number }>(async item => {
      item.retries++
      await workerPromise
    })

    queue.push({ id: 'item-1', retries: 0 })

    // Allow worker to start
    await vi.waitFor(() => {
      expect(queue.length).toBe(1)
      expect(queue[0]?.id).toBe('item-1')
      expect(queue[0]?.retries).toBe(1)
      expect(queue.isBusy).toBe(true)
    })

    releaseWorker()
    await queue.whenIdle()

    expect(queue.length).toBe(0)
    expect(queue.isBusy).toBe(false)
  })

  it('preserves the active item at index 0 when unshift is called while an item is in-flight', async () => {
    const executionOrder: string[] = []
    let releaseFirstItem!: () => void
    const firstItemPromise = new Promise<void>(resolve => {
      releaseFirstItem = resolve
    })

    const queue = new AsyncQueue<string>(async item => {
      executionOrder.push(`start:${item}`)
      if (item === 'first') {
        await firstItemPromise
      } else {
        await new Promise(resolve => setTimeout(resolve, 5))
      }
      executionOrder.push(`end:${item}`)
    })

    queue.push('first')

    // Wait until 'first' has started
    await vi.waitFor(() => {
      expect(executionOrder).toContain('start:first')
    })

    // While 'first' is in-flight, unshift 'p1' and 'p2' (e.g. requeued missing key messages)
    // and push 'normal'
    queue.push('normal')
    queue.unshift('p1', 'p2')

    // The active item must remain at index 0!
    expect(queue[0]).toBe('first')
    expect(queue.at(1)).toBe('p1')
    expect(queue.at(2)).toBe('p2')
    expect(queue.at(3)).toBe('normal')

    // Release the first item
    releaseFirstItem()
    await queue.whenIdle()

    // 'first' should complete, then 'p1', then 'p2', then 'normal'
    expect(executionOrder).toEqual([
      'start:first',
      'end:first',
      'start:p1',
      'end:p1',
      'start:p2',
      'end:p2',
      'start:normal',
      'end:normal',
    ])
  })

  it('unshifts multiple items preserving their order', async () => {
    const executed: string[] = []
    let releaseDrain!: () => void
    const gatePromise = new Promise<void>(resolve => {
      releaseDrain = resolve
    })

    const queue = new AsyncQueue<string>(async item => {
      await gatePromise
      executed.push(item)
    })

    // Unshift multiple items in one call
    queue.unshift('a', 'b')

    expect(queue[0]).toBe('a')
    expect(queue.at(1)).toBe('b')

    releaseDrain()
    await queue.whenIdle()

    expect(executed).toEqual(['a', 'b'])
  })

  it('continues processing subsequent items and resets isBusy if worker throws an unhandled error', async () => {
    const executed: string[] = []
    const onError = vi.fn()

    const queue = new AsyncQueue<string>(
      async item => {
        if (item === 'bad') {
          throw new Error('Worker crash')
        }
        executed.push(item)
      },
      { onError }
    )

    queue.push('bad', 'good1')
    await queue.whenIdle()

    expect(onError).toHaveBeenCalledWith(expect.any(Error), 'bad')
    expect(executed).toEqual(['good1'])
    expect(queue.isBusy).toBe(false)
    expect(queue.length).toBe(0)

    // Should be able to process new items after an error
    queue.push('good2')
    await queue.whenIdle()
    expect(executed).toEqual(['good1', 'good2'])
  })

  it('clears pending items when clear() is called', async () => {
    const executed: string[] = []
    let releaseFirst!: () => void
    const firstPromise = new Promise<void>(resolve => {
      releaseFirst = resolve
    })

    const queue = new AsyncQueue<string>(async item => {
      executed.push(`start:${item}`)
      if (item === 'first') {
        await firstPromise
      }
      executed.push(`end:${item}`)
    })

    queue.push('first', 'second', 'third')

    await vi.waitFor(() => {
      expect(executed).toContain('start:first')
    })

    queue.clear()
    expect(queue.length).toBe(0)
    expect(queue.isEmpty).toBe(true)

    releaseFirst()
    await queue.whenIdle()

    expect(executed).toEqual(['start:first', 'end:first'])
    expect(queue.length).toBe(0)
  })

  it('supports iteration with for..of and Array.from', () => {
    const queue = new AsyncQueue<number>(() => {})
    // Manually push to items for testing iteration
    ;(queue as any).items.push(10, 20, 30)

    expect(Array.from(queue)).toEqual([10, 20, 30])
    const values: number[] = []
    for (const val of queue) {
      values.push(val)
    }
    expect(values).toEqual([10, 20, 30])
  })

  it('resolves whenIdle immediately if queue is already empty and not processing', async () => {
    const queue = new AsyncQueue<number>(() => {})
    await expect(queue.whenIdle()).resolves.toBeUndefined()
  })
})



import { AsyncQueue } from './AsyncQueue'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>(res => {
    resolve = res
  })
  return { promise, resolve }
}

describe('AsyncQueue', () => {
  it('processes items one at a time in FIFO order', async () => {
    const events: string[] = []
    const queue = new AsyncQueue<number>(async item => {
      events.push(`start:${item}`)
      await new Promise(resolve => setTimeout(resolve, 5))
      events.push(`end:${item}`)
    })

    queue.push(1, 2)
    queue.push(3)

    await vi.waitFor(() => {
      expect(events).toEqual(['start:1', 'end:1', 'start:2', 'end:2', 'start:3', 'end:3'])
    })
  })

  it('logs a worker error and carries on with later items', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const executed: string[] = []
    const queue = new AsyncQueue<string>(async item => {
      if (item === 'bad') {
        throw new Error('Worker crash')
      }
      executed.push(item)
    })

    queue.push('bad', 'good1')
    await vi.waitFor(() => {
      expect(executed).toEqual(['good1'])
    })
    expect(consoleErrorSpy).toHaveBeenCalledWith('[AsyncQueue] Unhandled error in queue worker:', expect.any(Error))

    queue.push('good2')
    await vi.waitFor(() => {
      expect(executed).toEqual(['good1', 'good2'])
    })
    consoleErrorSpy.mockRestore()
  })

  it('drops pending items on clear but lets the running item finish', async () => {
    const executed: string[] = []
    const first = deferred()
    const queue = new AsyncQueue<string>(async item => {
      executed.push(`start:${item}`)
      if (item === 'first') {
        await first.promise
      }
      executed.push(`end:${item}`)
    })

    queue.push('first', 'second', 'third')
    await vi.waitFor(() => {
      expect(executed).toContain('start:first')
    })

    queue.clear()
    first.resolve()
    await vi.waitFor(() => {
      expect(executed).toEqual(['start:first', 'end:first'])
    })

    queue.push('fourth')
    await vi.waitFor(() => {
      expect(executed).toEqual(['start:first', 'end:first', 'start:fourth', 'end:fourth'])
    })
  })
})

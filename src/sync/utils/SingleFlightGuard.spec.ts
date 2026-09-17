import { SingleFlightGuard, TaskDeduplicator, KeyedSingleFlightGuard } from './SingleFlightGuard'

describe('SingleFlightGuard', () => {
  it('exports TaskDeduplicator as an alias for SingleFlightGuard', () => {
    expect(TaskDeduplicator).toBe(SingleFlightGuard)
  })

  it('runs an asynchronous function and returns its result', async () => {
    const guard = new SingleFlightGuard<number>()
    const fn = vi.fn().mockResolvedValue(42)

    const result = await guard.run(fn)

    expect(result).toBe(42)
    expect(fn).toHaveBeenCalledTimes(1)
    expect(guard.isRunning).toBe(false)
    expect(guard.currentPromise).toBeNull()
  })

  it('deduplicates concurrent calls, executing the task only once', async () => {
    const guard = new SingleFlightGuard<string>()
    let resolveTask: (val: string) => void = () => {}
    const fn = vi.fn().mockImplementation(
      () => new Promise<string>(resolve => { resolveTask = resolve })
    )

    const call1 = guard.run(fn)
    const call2 = guard.run(fn)
    const call3 = guard.run(fn)

    expect(guard.isRunning).toBe(true)
    expect(guard.currentPromise).toBeDefined()
    expect(fn).toHaveBeenCalledTimes(1)

    resolveTask('completed')

    const [res1, res2, res3] = await Promise.all([call1, call2, call3])
    expect(res1).toBe('completed')
    expect(res2).toBe('completed')
    expect(res3).toBe('completed')

    expect(guard.isRunning).toBe(false)
    expect(guard.currentPromise).toBeNull()
  })

  it('allows a new execution after the prior one settles', async () => {
    const guard = new SingleFlightGuard<number>()
    let count = 0
    const fn = vi.fn().mockImplementation(async () => {
      count += 1
      return count
    })

    const first = await guard.run(fn)
    expect(first).toBe(1)
    expect(guard.isRunning).toBe(false)

    const second = await guard.run(fn)
    expect(second).toBe(2)
    expect(guard.isRunning).toBe(false)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('propagates rejections to all coalesced callers and resets isRunning', async () => {
    const guard = new SingleFlightGuard<void>()
    let rejectTask: (err: Error) => void = () => {}
    const fn = vi.fn().mockImplementation(
      () => new Promise<void>((_, reject) => { rejectTask = reject })
    )

    const call1 = guard.run(fn)
    const call2 = guard.run(fn)

    expect(guard.isRunning).toBe(true)

    const testError = new Error('Task failed')
    rejectTask(testError)

    await expect(call1).rejects.toThrow('Task failed')
    await expect(call2).rejects.toThrow('Task failed')

    expect(guard.isRunning).toBe(false)
    expect(guard.currentPromise).toBeNull()

    // Subsequent call succeeds
    const successFn = vi.fn().mockResolvedValue('ok')
    await expect(guard.run(successFn as any)).resolves.toBe('ok')
  })

  it('handles synchronous throw in task without leaving dirty running state', async () => {
    const guard = new SingleFlightGuard<void>()
    const syncThrowFn = vi.fn().mockImplementation(() => {
      throw new Error('Immediate failure')
    })

    await expect(guard.run(syncThrowFn)).rejects.toThrow('Immediate failure')
    expect(guard.isRunning).toBe(false)
    expect(guard.currentPromise).toBeNull()
  })

  it('triggers onCoalesce callback when concurrent calls coalesce', async () => {
    const guard = new SingleFlightGuard<string>()
    let resolveTask: (val: string) => void = () => {}
    const fn = vi.fn().mockImplementation(
      () => new Promise<string>(resolve => { resolveTask = resolve })
    )
    const onCoalesce1 = vi.fn()
    const onCoalesce2 = vi.fn()

    const call1 = guard.run(fn)
    expect(onCoalesce1).not.toHaveBeenCalled()

    const call2 = guard.run(fn, { onCoalesce: onCoalesce1 })
    expect(onCoalesce1).toHaveBeenCalledTimes(1)

    const call3 = guard.run(fn, { onCoalesce: onCoalesce2 })
    expect(onCoalesce2).toHaveBeenCalledTimes(1)

    resolveTask('done')
    await Promise.all([call1, call2, call3])
  })

  describe('waitForRunning', () => {
    it('returns undefined immediately when idle', async () => {
      const guard = new SingleFlightGuard<string>()
      const result = await guard.waitForRunning()
      expect(result).toBeUndefined()
    })

    it('awaits the active flight and returns the resolved value', async () => {
      const guard = new SingleFlightGuard<string>()
      let resolveTask: (val: string) => void = () => {}
      const fn = () => new Promise<string>(resolve => { resolveTask = resolve })

      void guard.run(fn)
      expect(guard.isRunning).toBe(true)

      let waitCompleted = false
      const waitPromise = guard.waitForRunning().then(val => {
        waitCompleted = true
        return val
      })

      expect(waitCompleted).toBe(false)
      resolveTask('finished')

      const waitResult = await waitPromise
      expect(waitCompleted).toBe(true)
      expect(waitResult).toBe('finished')
    })

    it('safely catches rejection without throwing and returns undefined', async () => {
      const guard = new SingleFlightGuard<string>()
      let rejectTask: (err: Error) => void = () => {}
      const fn = () => new Promise<string>((_, reject) => { rejectTask = reject })

      const activeCall = guard.run(fn)
      const waitPromise = guard.waitForRunning()

      rejectTask(new Error('Background error'))

      // waitForRunning suppresses error
      const waitResult = await waitPromise
      expect(waitResult).toBeUndefined()

      // The original runner still sees the rejection
      await expect(activeCall).rejects.toThrow('Background error')
    })
  })

  describe('clear', () => {
    it('resets running and currentPromise', async () => {
      const guard = new SingleFlightGuard<void>()
      let resolveTask: () => void = () => {}
      const fn = () => new Promise<void>(resolve => { resolveTask = resolve })

      void guard.run(fn)
      expect(guard.isRunning).toBe(true)
      expect(guard.currentPromise).not.toBeNull()

      guard.clear()
      expect(guard.isRunning).toBe(false)
      expect(guard.currentPromise).toBeNull()

      resolveTask()
    })
  })
})

describe('KeyedSingleFlightGuard', () => {
  it('coalesces concurrent calls for the same key', async () => {
    const guard = new KeyedSingleFlightGuard<string, number>()
    let executions = 0

    const fn = async () => {
      executions += 1
      await new Promise(resolve => setTimeout(resolve, 10))
      return 42
    }

    const [r1, r2, r3] = await Promise.all([
      guard.run('keyA', fn),
      guard.run('keyA', fn),
      guard.run('keyA', fn),
    ])

    expect(executions).toBe(1)
    expect(r1).toBe(42)
    expect(r2).toBe(42)
    expect(r3).toBe(42)
  })

  it('runs tasks with different keys concurrently and independently', async () => {
    const guard = new KeyedSingleFlightGuard<string, string>()
    const executions: string[] = []

    const fn = (key: string) => async () => {
      executions.push(key)
      await new Promise(resolve => setTimeout(resolve, 10))
      return `result-${key}`
    }

    const [rA, rB] = await Promise.all([
      guard.run('keyA', fn('keyA')),
      guard.run('keyB', fn('keyB')),
    ])

    expect(executions).toContain('keyA')
    expect(executions).toContain('keyB')
    expect(rA).toBe('result-keyA')
    expect(rB).toBe('result-keyB')
  })

  it('cleans up the key on resolution and allows subsequent runs', async () => {
    const guard = new KeyedSingleFlightGuard<string, number>()
    let counter = 0

    const fn = async () => {
      counter += 1
      return counter
    }

    const r1 = await guard.run('item1', fn)
    expect(r1).toBe(1)
    expect(guard.isRunning('item1')).toBe(false)
    expect(guard.activeKeys.has('item1')).toBe(false)

    const r2 = await guard.run('item1', fn)
    expect(r2).toBe(2)
  })

  it('cleans up the key on rejection and notifies all coalesced callers', async () => {
    const guard = new KeyedSingleFlightGuard<string, void>()
    let attempts = 0

    const failingFn = async () => {
      attempts += 1
      await new Promise(resolve => setTimeout(resolve, 10))
      throw new Error('Key failure')
    }

    const [p1, p2] = [
      guard.run('itemX', failingFn),
      guard.run('itemX', failingFn),
    ]

    await expect(p1).rejects.toThrow('Key failure')
    await expect(p2).rejects.toThrow('Key failure')
    expect(attempts).toBe(1)
    expect(guard.isRunning('itemX')).toBe(false)
  })

  it('invokes onCoalesce when concurrent callers join an in-flight key', async () => {
    const guard = new KeyedSingleFlightGuard<string, string>()
    let coalesced = 0
    let resolveTask!: (val: string) => void
    const taskPromise = new Promise<string>(r => { resolveTask = r })

    const p1 = guard.run('k1', () => taskPromise)
    const p2 = guard.run('k1', () => taskPromise, {
      onCoalesce: () => { coalesced += 1 },
    })

    expect(coalesced).toBe(1)
    resolveTask('done')
    await Promise.all([p1, p2])
  })

  it('provides getPromise and waitForRunning for active keys', async () => {
    const guard = new KeyedSingleFlightGuard<string, string>()
    let resolveTask!: (val: string) => void
    const taskPromise = new Promise<string>(r => { resolveTask = r })

    void guard.run('doc1', () => taskPromise)

    expect(guard.isRunning('doc1')).toBe(true)
    expect(guard.getPromise('doc1')).toBeDefined()

    const waitPromise = guard.waitForRunning('doc1')
    resolveTask('resolved')

    const result = await waitPromise
    expect(result).toBe('resolved')
  })

  it('supports clear(key) and clear()', async () => {
    const guard = new KeyedSingleFlightGuard<string, void>()
    let resolveA!: () => void
    let resolveB!: () => void
    const taskA = new Promise<void>(r => { resolveA = r })
    const taskB = new Promise<void>(r => { resolveB = r })

    void guard.run('a', () => taskA)
    void guard.run('b', () => taskB)

    expect(guard.isRunning('a')).toBe(true)
    expect(guard.isRunning('b')).toBe(true)

    guard.clear('a')
    expect(guard.isRunning('a')).toBe(false)
    expect(guard.isRunning('b')).toBe(true)

    guard.clear()
    expect(guard.isRunning('b')).toBe(false)

    resolveA()
    resolveB()
  })
})


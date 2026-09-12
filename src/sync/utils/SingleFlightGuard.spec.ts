import { describe, it, expect, vi } from 'vitest'
import { SingleFlightGuard, TaskDeduplicator } from './SingleFlightGuard'

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
    const fn = vi.fn().mockImplementation(async () => ++count)

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

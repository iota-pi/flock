import { AbortableRun } from './AbortableRun'
import { AbortError, isAbortError } from './abort'

describe('AbortableRun', () => {
  it('passes a live signal and returns the result', async () => {
    const run = new AbortableRun()
    let seen: AbortSignal | null = null

    const result = await run.run(async signal => {
      seen = signal
      expect(run.isRunning).toBe(true)
      return 42
    })

    expect(result).toBe(42)
    expect(seen!.aborted).toBe(false)
    expect(run.isRunning).toBe(false)
  })

  it('does not start fn when not alive', async () => {
    const run = new AbortableRun(() => false)
    const fn = vi.fn(async () => 1)

    await expect(run.run(fn)).rejects.toBeInstanceOf(AbortError)
    expect(fn).not.toHaveBeenCalled()
    expect(run.isRunning).toBe(false)
  })

  it('aborts the running signal and clears it', async () => {
    const run = new AbortableRun()
    let resolveStarted!: () => void
    const started = new Promise<void>(resolve => {
      resolveStarted = resolve
    })

    const promise = run.run(signal => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('fetch failed')))
      resolveStarted()
    }))
    await started
    run.abort()

    expect(run.isRunning).toBe(false)
    await expect(promise).rejects.toBeInstanceOf(AbortError)
  })

  it('reports an error thrown after going dead as an abort', async () => {
    let alive = true
    const run = new AbortableRun(() => alive)

    const error = await run.run(async () => {
      alive = false
      throw new Error('network down')
    }).catch((err: unknown) => err)

    expect(isAbortError(error)).toBe(true)
  })

  it('rethrows errors from a live run unchanged', async () => {
    const run = new AbortableRun()
    const failure = new Error('boom')

    await expect(run.run(async () => {
      throw failure
    })).rejects.toBe(failure)
  })

  it('aborts with the outer signal', async () => {
    const run = new AbortableRun()
    const outer = new AbortController()
    let seen: AbortSignal | null = null

    await run.run(async signal => {
      seen = signal
      outer.abort()
    }, outer.signal)

    expect(seen!.aborted).toBe(true)
  })

  it('leaves a newer run in place when an older one finishes', async () => {
    const run = new AbortableRun()
    let finishFirst!: () => void
    const first = run.run(() => new Promise<void>(resolve => {
      finishFirst = resolve
    }))
    let secondSignal: AbortSignal | null = null
    let finishSecond!: () => void
    const second = run.run(signal => new Promise<void>(resolve => {
      secondSignal = signal
      finishSecond = resolve
    }))

    finishFirst()
    await first
    expect(run.isRunning).toBe(true)

    run.abort()
    expect(secondSignal!.aborted).toBe(true)
    finishSecond()
    await second
    expect(run.isRunning).toBe(false)
  })
})

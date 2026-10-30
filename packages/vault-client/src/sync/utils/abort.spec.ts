import { AbortError, isAbortError, checkAlive, abortReason, untilAborted, delay } from './abort'

describe('abort utility', () => {
  describe('AbortError', () => {
    it('creates an error with name AbortError', () => {
      const err = new AbortError('Test abort')
      expect(err).toBeInstanceOf(Error)
      expect(err).toBeInstanceOf(AbortError)
      expect(err.name).toBe('AbortError')
      expect(err.message).toBe('Test abort')
    })

    it('defaults message to Operation aborted', () => {
      const err = new AbortError()
      expect(err.message).toBe('Operation aborted')
    })
  })

  describe('isAbortError', () => {
    it('identifies AbortError instance', () => {
      expect(isAbortError(new AbortError())).toBe(true)
    })

    it('identifies standard Error with name AbortError', () => {
      const err = new Error('aborted')
      err.name = 'AbortError'
      expect(isAbortError(err)).toBe(true)
    })

    it('identifies DOMException with name AbortError', () => {
      const domErr = new DOMException('aborted', 'AbortError')
      expect(isAbortError(domErr)).toBe(true)
    })

    it('returns false for non-abort errors', () => {
      expect(isAbortError(new Error('something else'))).toBe(false)
      expect(isAbortError(null)).toBe(false)
      expect(isAbortError(undefined)).toBe(false)
      expect(isAbortError('error string')).toBe(false)
    })
  })

  describe('checkAlive', () => {
    it('does nothing when signal is not aborted and isAlive is true', () => {
      const controller = new AbortController()
      expect(() => checkAlive(controller.signal, true)).not.toThrow()
      expect(() => checkAlive(null, true)).not.toThrow()
      expect(() => checkAlive(undefined, () => true)).not.toThrow()
    })

    it('throws AbortError when signal is aborted', () => {
      const controller = new AbortController()
      controller.abort()
      expect(() => checkAlive(controller.signal, true)).toThrow(AbortError)
    })

    it('throws AbortError with custom abort reason when signal is aborted with string', () => {
      const controller = new AbortController()
      controller.abort('custom reason')
      let thrown: unknown
      try {
        checkAlive(controller.signal, true)
      } catch (err) {
        thrown = err
      }
      expect(thrown).toBeInstanceOf(AbortError)
      expect((thrown as Error).message).toBe('custom reason')
    })

    it('throws AbortError when isAlive is false', () => {
      expect(() => checkAlive(null, false, 'Leader lost')).toThrowError('Leader lost')
    })

    it('throws AbortError when isAlive function returns false', () => {
      const active = false
      expect(() => checkAlive(null, () => active, 'Inactive')).toThrowError('Inactive')
    })
  })

  describe('abortReason', () => {
    it('returns an Error reason as it is', () => {
      const controller = new AbortController()
      const reason = new Error('Stopped')
      controller.abort(reason)
      expect(abortReason(controller.signal)).toBe(reason)
    })

    it('wraps a string reason in an AbortError', () => {
      const controller = new AbortController()
      controller.abort('Stopped')
      const reason = abortReason(controller.signal)
      expect(reason).toBeInstanceOf(AbortError)
      expect(reason.message).toBe('Stopped')
    })

    it('uses the message for any other reason', () => {
      const controller = new AbortController()
      controller.abort(42)
      expect(abortReason(controller.signal, 'Gave up').message).toBe('Gave up')
    })
  })

  describe('untilAborted', () => {
    it('settles with the promise while the signal stays live', async () => {
      const controller = new AbortController()
      await expect(untilAborted(Promise.resolve('done'), controller.signal)).resolves.toBe('done')
      await expect(untilAborted(Promise.reject(new Error('Failed')), controller.signal)).rejects.toThrow('Failed')
    })

    it('rejects with an AbortError once the signal aborts, without waiting for the promise', async () => {
      const controller = new AbortController()
      const pending = untilAborted(new Promise<never>(() => {}), controller.signal)
      const cause = new Error('Caller cancelled')
      controller.abort(cause)
      const err = await pending.catch((e: Error) => e)
      expect(err).toBeInstanceOf(AbortError)
      expect(err.message).toBe('Caller cancelled')
      expect(err.cause).toBe(cause)
    })

    it('rejects at once when the signal is already aborted', async () => {
      const controller = new AbortController()
      const reason = new AbortError('Already stopped')
      controller.abort(reason)
      await expect(untilAborted(new Promise(() => {}), controller.signal)).rejects.toBe(reason)
    })
  })

  describe('delay', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('resolves after the delay', async () => {
      const done = vi.fn()
      void delay(100).then(done)
      await vi.advanceTimersByTimeAsync(99)
      expect(done).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(done).toHaveBeenCalled()
    })

    it('rejects with the abort reason as soon as the signal aborts', async () => {
      const controller = new AbortController()
      const waiting = delay(100, controller.signal)
      const reason = new Error('Stopped')
      controller.abort(reason)
      await expect(waiting).rejects.toBe(reason)
      expect(vi.getTimerCount()).toBe(0)
    })

    it('rejects at once when the signal is already aborted', async () => {
      const controller = new AbortController()
      controller.abort('Stopped')
      await expect(delay(100, controller.signal)).rejects.toThrow('Stopped')
    })
  })
})

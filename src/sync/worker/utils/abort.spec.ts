import { AbortError, isAbortError, checkAlive } from './abort'

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
      try {
        checkAlive(controller.signal, true)
        expect.unreachable('Should have thrown')
      } catch (err: any) {
        expect(err).toBeInstanceOf(AbortError)
        expect(err.message).toBe('custom reason')
      }
    })

    it('throws AbortError when isAlive is false', () => {
      expect(() => checkAlive(null, false, 'Leader lost')).toThrowError('Leader lost')
    })

    it('throws AbortError when isAlive function returns false', () => {
      const active = false
      expect(() => checkAlive(null, () => active, 'Inactive')).toThrowError('Inactive')
    })
  })
})

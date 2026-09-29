import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fireAndForget } from './fireAndForget'

describe('fireAndForget', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    consoleErrorSpy.mockRestore()
  })

  it('runs resolving promises without errors or logs', async () => {
    const promise = Promise.resolve('ok')
    fireAndForget(promise, 'TestTag')
    await promise
    expect(consoleErrorSpy).not.toHaveBeenCalled()
  })

  it('catches rejected promises and logs with diagnostic tag', async () => {
    const error = new Error('Async explosion')
    const promise = Promise.reject(error)
    fireAndForget(promise, 'TestTag')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(consoleErrorSpy).toHaveBeenCalledWith('[TestTag] Unhandled async error:', error)
  })

  it('handles lazy factory functions that return a resolving promise', async () => {
    const factory = vi.fn().mockResolvedValue('ok')
    fireAndForget(factory, 'LazyTag')
    expect(factory).toHaveBeenCalledTimes(1)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(consoleErrorSpy).not.toHaveBeenCalled()
  })

  it('catches rejections from lazy factory functions', async () => {
    const error = new Error('Lazy async error')
    fireAndForget(() => Promise.reject(error), 'LazyTag')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(consoleErrorSpy).toHaveBeenCalledWith('[LazyTag] Unhandled async error:', error)
  })

  it('catches synchronous errors thrown by lazy factory functions', () => {
    const syncError = new Error('Sync explosion')
    fireAndForget(() => {
      throw syncError
    }, 'SyncTag')
    expect(consoleErrorSpy).toHaveBeenCalledWith('[SyncTag] Unhandled synchronous error:', syncError)
  })

  it('calls custom onError handler on async rejection', async () => {
    const error = new Error('Custom handler async')
    const customHandler = vi.fn()
    fireAndForget(Promise.reject(error), 'CustomTag', customHandler)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(customHandler).toHaveBeenCalledWith(error)
    expect(consoleErrorSpy).not.toHaveBeenCalled()
  })

  it('calls custom onError handler on sync error', () => {
    const error = new Error('Custom handler sync')
    const customHandler = vi.fn()
    fireAndForget(() => {
      throw error
    }, 'CustomTag', customHandler)
    expect(customHandler).toHaveBeenCalledWith(error)
    expect(consoleErrorSpy).not.toHaveBeenCalled()
  })

  it('safely catches error if custom onError handler throws', async () => {
    const originalError = new Error('Original error')
    const handlerError = new Error('Handler threw')
    const failingHandler = () => {
      throw handlerError
    }
    fireAndForget(Promise.reject(originalError), 'FailingHandlerTag', failingHandler)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '[FailingHandlerTag] Error in fireAndForget onError handler:',
      handlerError,
    )
  })

  it('handles non-promise values gracefully', () => {
    expect(() => fireAndForget(null, 'NullTag')).not.toThrow()
    expect(() => fireAndForget(undefined, 'UndefinedTag')).not.toThrow()
    expect(() => fireAndForget(123 as unknown as Promise<unknown>, 'NumTag')).not.toThrow()
    expect(() => fireAndForget(() => 'string' as unknown as Promise<unknown>, 'FnTag')).not.toThrow()
    expect(consoleErrorSpy).not.toHaveBeenCalled()
  })
})

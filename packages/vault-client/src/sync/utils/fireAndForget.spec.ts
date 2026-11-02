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

  it('calls custom onError handler on async rejection', async () => {
    const error = new Error('Custom handler async')
    const customHandler = vi.fn()
    fireAndForget(Promise.reject(error), 'CustomTag', customHandler)
    await new Promise(resolve => setTimeout(resolve, 0))
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
})

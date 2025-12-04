describe('app/src/api/axios', () => {
  it('throws when not initialised', async () => {
    vi.resetModules()
    const mod = await import('./axios')
    const { getAxios } = mod
    expect(() => getAxios()).toThrowError('Axios has not yet been initialised')
  })

  it('getAxios(allowNoInit = true) returns an axios instance when not initialised', async () => {
    vi.resetModules()
    const mod = await import('./axios')
    const { getAxios } = mod
    const inst = getAxios(true)
    expect(inst).toBeTruthy()
    expect(typeof (inst as any).request).toBe('function')
    expect((inst as any).defaults).toBeDefined()
  })

  it('initAxios sets Authorization header on the created instance', async () => {
    vi.resetModules()
    const mod = await import('./axios')
    const { initAxios, getAxios } = mod
    initAxios('tok123')
    const inst = getAxios()
    const hdrs = (inst as any).defaults?.headers ?? {}
    const auth =
      hdrs.Authorization ?? (hdrs.common && (hdrs.common as any).Authorization)
    expect(auth).toBe('Basic tok123')
  })

  it('re-initialising replaces instance and updates Authorization header', async () => {
    vi.resetModules()
    const mod = await import('./axios')
    const { initAxios, getAxios } = mod
    initAxios('a')
    const first = getAxios()
    initAxios('b')
    const second = getAxios()
    expect(second).not.toBe(first)

    const hdrs2 = (second as any).defaults?.headers ?? {}
    const auth2 =
      hdrs2.Authorization ?? (hdrs2.common && (hdrs2.common as any).Authorization)
    expect(auth2).toBe('Basic b')
  })

  it('getAxios(true) after init returns the same instance reference', async () => {
    vi.resetModules()
    const mod = await import('./axios')
    const { initAxios, getAxios } = mod
    initAxios('x')
    const a = getAxios()
    const b = getAxios(true)
    expect(b).toBe(a)
  })

  it('setSessionExpiredHandler registers a callback for 403 errors', async () => {
    vi.resetModules()
    const mod = await import('./axios')
    const { initAxios, setSessionExpiredHandler } = mod

    const handler = vi.fn()
    setSessionExpiredHandler(handler)
    initAxios('token')

    // Handler should not have been called yet
    expect(handler).not.toHaveBeenCalled()
  })

  it('calls session expired handler on 403 response', async () => {
    vi.resetModules()
    const mod = await import('./axios')
    const { initAxios, getAxios, setSessionExpiredHandler } = mod

    const handler = vi.fn()
    setSessionExpiredHandler(handler)
    initAxios('token')

    const instance = getAxios()

    // Manually trigger the response interceptor with a 403 error
    const interceptors = (instance as any).interceptors.response.handlers
    const errorHandler = interceptors[0]?.rejected

    // Simulate a 403 error
    const error = { response: { status: 403 } }
    await errorHandler(error).catch(() => {})

    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('does not call session expired handler on non-403 errors', async () => {
    vi.resetModules()
    const mod = await import('./axios')
    const { initAxios, getAxios, setSessionExpiredHandler } = mod

    const handler = vi.fn()
    setSessionExpiredHandler(handler)
    initAxios('token')

    const instance = getAxios()
    const interceptors = (instance as any).interceptors.response.handlers
    const errorHandler = interceptors[0]?.rejected

    // Simulate a 401 error
    const error401 = { response: { status: 401 } }
    await errorHandler(error401).catch(() => {})

    // Simulate a 500 error
    const error500 = { response: { status: 500 } }
    await errorHandler(error500).catch(() => {})

    expect(handler).not.toHaveBeenCalled()
  })

  it('does not throw if no session expired handler is registered', async () => {
    vi.resetModules()
    const mod = await import('./axios')
    const { initAxios, getAxios } = mod

    // Don't register a handler
    initAxios('token')

    const instance = getAxios()
    const interceptors = (instance as any).interceptors.response.handlers
    const errorHandler = interceptors[0]?.rejected

    // Simulate a 403 error - should not throw
    const error = { response: { status: 403 } }
    await expect(errorHandler(error)).rejects.toEqual(error)
  })
})

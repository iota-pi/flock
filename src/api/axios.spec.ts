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
})

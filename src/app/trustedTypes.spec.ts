import { createDefaultPolicyOptions, installDefaultTrustedTypesPolicy } from './trustedTypes'

const ORIGIN = 'https://flock.example'

describe('default Trusted Types policy', () => {
  const policy = createDefaultPolicyOptions(ORIGIN)

  it('allows same-origin script URLs', () => {
    expect(policy.createScriptURL!('/assets/vault.worker-abc.js')).toBe('/assets/vault.worker-abc.js')
    expect(policy.createScriptURL!(`${ORIGIN}/service-worker.js`)).toBe(`${ORIGIN}/service-worker.js`)
  })

  it('blocks script URLs from other origins', () => {
    expect(() => policy.createScriptURL!('https://evil.example/x.js')).toThrow(TypeError)
    expect(() => policy.createScriptURL!('//evil.example/x.js')).toThrow(TypeError)
    expect(() => policy.createScriptURL!('data:text/javascript,alert(1)')).toThrow(TypeError)
  })

  it('allows the date field section text', () => {
    expect(policy.createHTML!('15')).toBe('15')
    expect(policy.createHTML!('MM/DD/YYYY')).toBe('MM/DD/YYYY')
    expect(policy.createHTML!('November')).toBe('November')
  })

  it('blocks HTML containing markup or entities', () => {
    expect(() => policy.createHTML!('<img src=x onerror=alert(1)>')).toThrow(TypeError)
    expect(() => policy.createHTML!('&lt;b&gt;')).toThrow(TypeError)
  })

  it('registers itself as the default policy when the browser supports Trusted Types', () => {
    const createPolicy = vi.fn()
    installDefaultTrustedTypesPolicy({ createPolicy }, ORIGIN)
    expect(createPolicy).toHaveBeenCalledWith('default', expect.any(Object))
  })

  it('does nothing without Trusted Types support', () => {
    expect(() => installDefaultTrustedTypesPolicy(undefined, ORIGIN)).not.toThrow()
  })
})

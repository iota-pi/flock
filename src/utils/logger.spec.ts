import { createLogger } from './logger'

describe('createLogger', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  it('prefixes each level with the tag', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const log = createLogger('Login')

    log.error('Login failed:', 'offline')
    log.warn('Slow server')
    log.info('Signed in')

    expect(log.tag).toBe('Login')
    expect(error).toHaveBeenCalledWith('[Login]', 'Login failed:', 'offline')
    expect(warn).toHaveBeenCalledWith('[Login]', 'Slow server')
    expect(info).toHaveBeenCalledWith('[Login]', 'Signed in')
  })

  it('can be passed as a rejection handler', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const failure = new Error('offline')

    await Promise.reject(failure).catch(createLogger('Sync').error)

    expect(error).toHaveBeenCalledWith('[Sync]', failure)
  })

  it('prints debug messages only in development', () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
    const log = createLogger('Prayer')

    vi.stubEnv('DEV', true)
    log.debug('Schedule built')
    vi.stubEnv('DEV', false)
    log.debug('Hidden')

    expect(debug).toHaveBeenCalledTimes(1)
    expect(debug).toHaveBeenCalledWith('[Prayer]', 'Schedule built')
  })
})

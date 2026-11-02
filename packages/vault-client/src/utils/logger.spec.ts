import { createLogger } from './logger'

describe('createLogger', () => {
  let errorSpy: any
  let warnSpy: any
  let infoSpy: any
  let debugSpy: any
  let logSpy: any

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
    debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('prefixes string messages with [tag]', () => {
    const log = createLogger('SyncEventProcessor')
    expect(log.tag).toBe('SyncEventProcessor')
    expect(log.prefix).toBe('[SyncEventProcessor]')

    log.error('Mutation failed:', 'addItem')
    expect(errorSpy).toHaveBeenCalledWith('[SyncEventProcessor] Mutation failed:', 'addItem')

    log.warn('Warning occurred')
    expect(warnSpy).toHaveBeenCalledWith('[SyncEventProcessor] Warning occurred')

    log.info('Info message')
    expect(infoSpy).toHaveBeenCalledWith('[SyncEventProcessor] Info message')

    log.debug('Debug message')
    expect(debugSpy).toHaveBeenCalledWith('[SyncEventProcessor] Debug message')

    log.log('Log message')
    expect(logSpy).toHaveBeenCalledWith('[SyncEventProcessor] Log message')
  })

  it('strips existing brackets when provided in tag string', () => {
    const log = createLogger('[WorkerLifecycleManager]')
    expect(log.tag).toBe('WorkerLifecycleManager')
    expect(log.prefix).toBe('[WorkerLifecycleManager]')

    log.error('Failed to initialize SyncBridge:', new Error('Connection failed'))
    expect(errorSpy).toHaveBeenCalledWith(
      '[WorkerLifecycleManager] Failed to initialize SyncBridge:',
      expect.any(Error)
    )
  })

  it('handles class constructors and objects with a name property', () => {
    class CustomSyncHandler {}
    const log = createLogger(CustomSyncHandler)
    expect(log.tag).toBe('CustomSyncHandler')
    expect(log.prefix).toBe('[CustomSyncHandler]')

    log.info('Ready')
    expect(infoSpy).toHaveBeenCalledWith('[CustomSyncHandler] Ready')

    const objectWithTag = { name: 'ObjectTag' }
    const logFromObj = createLogger(objectWithTag)
    expect(logFromObj.tag).toBe('ObjectTag')
    expect(logFromObj.prefix).toBe('[ObjectTag]')
  })

  it('handles non-string first arguments properly', () => {
    const log = createLogger('SyncWorker')
    const err = new Error('Unexpected')
    log.error(err)
    expect(errorSpy).toHaveBeenCalledWith('[SyncWorker]', err)
  })

  it('handles empty arguments', () => {
    const log = createLogger('SyncWorker')
    log.info()
    expect(infoSpy).toHaveBeenCalledWith('[SyncWorker]')
  })

  it('avoids double-prefixing if message already starts with tag', () => {
    const log = createLogger('SyncWorker')
    log.warn('[SyncWorker] Multiple leaders detected.')
    expect(warnSpy).toHaveBeenCalledWith('[SyncWorker] Multiple leaders detected.')
  })

  it('handles empty or whitespace tag gracefully', () => {
    const log = createLogger('   ')
    expect(log.tag).toBe('')
    expect(log.prefix).toBe('')

    log.info('Simple message')
    expect(infoSpy).toHaveBeenCalledWith('Simple message')
  })
})

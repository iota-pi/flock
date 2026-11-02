import { AbortError } from '../utils/abort'
import { ServiceLifecycleManager } from './ServiceLifecycleManager'

describe('ServiceLifecycleManager', () => {
  let lifecycle: ServiceLifecycleManager<{ clearLocalData?: boolean }>

  beforeEach(() => {
    lifecycle = new ServiceLifecycleManager('TestLifecycle')
  })

  it('starts services in FIFO order (registration order)', async () => {
    const startOrder: string[] = []

    lifecycle
      .register({
        name: 'ServiceA',
        onStart: () => {
          startOrder.push('A')
        },
      })
      .register({
        name: 'ServiceB',
        onStart: () => {
          startOrder.push('B')
        },
      })
      .register({
        name: 'ServiceC',
        onStart: () => {
          startOrder.push('C')
        },
      })

    await lifecycle.start()

    expect(startOrder).toEqual(['A', 'B', 'C'])
  })

  it('stops services in LIFO order (reverse registration order)', async () => {
    const stopOrder: string[] = []

    lifecycle
      .register({
        name: 'ServiceA',
        onStop: () => {
          stopOrder.push('A')
        },
      })
      .register({
        name: 'ServiceB',
        onStop: () => {
          stopOrder.push('B')
        },
      })
      .register({
        name: 'ServiceC',
        onStop: () => {
          stopOrder.push('C')
        },
      })

    await lifecycle.start()
    await lifecycle.stop()

    expect(stopOrder).toEqual(['C', 'B', 'A'])
  })

  it('waits for an in-progress start before stopping, so no service starts after teardown', async () => {
    const events: string[] = []
    let finishA: () => void = () => {}

    lifecycle
      .register({
        name: 'ServiceA',
        onStart: () => new Promise<void>(resolve => {
          finishA = () => {
            events.push('start A')
            resolve()
          }
        }),
        onStop: () => {
          events.push('stop A')
        },
      })
      .register({
        name: 'ServiceB',
        onStart: () => {
          events.push('start B')
        },
        onStop: () => {
          events.push('stop B')
        },
      })

    const startPromise = lifecycle.start()
    const stopPromise = lifecycle.stop()
    finishA()
    await startPromise
    await stopPromise

    expect(events).toEqual(['start A', 'start B', 'stop B', 'stop A'])
  })

  it('forwards options to onStop hooks', async () => {
    const mockStopA = vi.fn()
    const mockStopB = vi.fn()

    lifecycle
      .register({ name: 'ServiceA', onStop: mockStopA })
      .register({ name: 'ServiceB', onStop: mockStopB })

    await lifecycle.start()
    await lifecycle.stop({ clearLocalData: true })

    expect(mockStopB).toHaveBeenCalledWith({ clearLocalData: true })
    expect(mockStopA).toHaveBeenCalledWith({ clearLocalData: true })
  })

  it('isolates teardown errors: failure in one service does not halt subsequent services', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const stopOrder: string[] = []

    lifecycle
      .register({
        name: 'ServiceA',
        onStop: () => {
          stopOrder.push('A')
        },
      })
      .register({
        name: 'ServiceB',
        onStop: () => {
          stopOrder.push('B')
          throw new Error('ServiceB teardown explosion')
        },
      })
      .register({
        name: 'ServiceC',
        onStop: () => {
          stopOrder.push('C')
        },
      })

    await lifecycle.start()
    await lifecycle.stop()

    // C should stop, B throws but continues, then A stops
    expect(stopOrder).toEqual(['C', 'B', 'A'])
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Error stopping service "ServiceB"'),
      expect.any(Error)
    )

    errorSpy.mockRestore()
  })

  it('rolls back already started services in LIFO order if startup fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const events: string[] = []

    lifecycle
      .register({
        name: 'ServiceA',
        onStart: () => {
          events.push('start:A')
        },
        onStop: () => {
          events.push('stop:A')
        },
      })
      .register({
        name: 'ServiceB',
        onStart: () => {
          events.push('start:B')
          throw new Error('ServiceB failed to start')
        },
        onStop: () => {
          events.push('stop:B')
        },
      })
      .register({
        name: 'ServiceC',
        onStart: () => {
          events.push('start:C')
        },
        onStop: () => {
          events.push('stop:C')
        },
      })

    await expect(lifecycle.start()).rejects.toThrow('ServiceB failed to start')

    // ServiceA was started, B failed, so A is rolled back. C was never started or stopped.
    expect(events).toEqual(['start:A', 'start:B', 'stop:A'])

    errorSpy.mockRestore()
  })

  it('does not stop the services again after rolling back', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const stopA = vi.fn()
    const stopB = vi.fn()
    const stopPassive = vi.fn()

    lifecycle
      .register({ name: 'ServiceA', onStart: () => {}, onStop: stopA })
      .register({ name: 'ServiceB', onStart: () => { throw new Error('ServiceB failed to start') }, onStop: stopB })
      .register({ name: 'PassiveService', onStop: stopPassive })

    await expect(lifecycle.start()).rejects.toThrow('ServiceB failed to start')
    await lifecycle.stop({ clearLocalData: true })

    expect(stopA).toHaveBeenCalledTimes(1)
    expect(stopB).not.toHaveBeenCalled()
    expect(stopPassive).toHaveBeenCalledTimes(1)

    errorSpy.mockRestore()
  })

  it('leaves the rollback to a waiting stop, which passes its options', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const stopA = vi.fn()
    let failB: (() => void) | undefined

    lifecycle
      .register({ name: 'ServiceA', onStart: () => {}, onStop: stopA })
      .register({
        name: 'ServiceB',
        onStart: () => new Promise<void>((_resolve, reject) => {
          failB = () => reject(new Error('ServiceB failed to start'))
        }),
      })

    const startPromise = lifecycle.start()
    await vi.waitFor(() => expect(failB).toBeDefined())
    const stopPromise = lifecycle.stop({ clearLocalData: true })
    failB?.()

    await expect(startPromise).rejects.toThrow('ServiceB failed to start')
    await stopPromise
    expect(stopA).toHaveBeenCalledTimes(1)
    expect(stopA).toHaveBeenCalledWith({ clearLocalData: true })

    errorSpy.mockRestore()
  })

  it('stops only the services without onStart when stopped before starting, and refuses to start after', async () => {
    const startA = vi.fn()
    const stopA = vi.fn()
    const stopPassive = vi.fn()

    lifecycle
      .register({ name: 'ServiceA', onStart: startA, onStop: stopA })
      .register({ name: 'PassiveService', onStop: stopPassive })

    await lifecycle.stop()

    await expect(lifecycle.start()).rejects.toThrow(AbortError)
    expect(startA).not.toHaveBeenCalled()
    expect(stopA).not.toHaveBeenCalled()
    expect(stopPassive).toHaveBeenCalledTimes(1)
  })

  it('refuses to start twice', async () => {
    const startA = vi.fn()
    lifecycle.register({ name: 'ServiceA', onStart: startA })

    await lifecycle.start()

    await expect(lifecycle.start()).rejects.toThrow('already been started')
    expect(startA).toHaveBeenCalledTimes(1)
  })

  it('makes a concurrent stop wait for the teardown in progress', async () => {
    let finishStop: (() => void) | undefined
    let stopped = false
    lifecycle.register({
      name: 'ServiceA',
      onStop: () => new Promise<void>(resolve => {
        finishStop = () => {
          stopped = true
          resolve()
        }
      }),
    })

    const firstStop = lifecycle.stop()
    const secondStop = lifecycle.stop().then(() => stopped)
    await vi.waitFor(() => expect(finishStop).toBeDefined())
    finishStop?.()

    await firstStop
    expect(await secondStop).toBe(true)
  })

  it('is idempotent on multiple calls to stop', async () => {
    const stopFn = vi.fn()
    lifecycle.register({ name: 'ServiceA', onStop: stopFn })

    await lifecycle.start()
    await lifecycle.stop()
    await lifecycle.stop()

    expect(stopFn).toHaveBeenCalledTimes(1)
  })

  it('handles services without onStart or onStop gracefully', async () => {
    lifecycle.register({ name: 'PassiveService' })

    await expect(lifecycle.start()).resolves.toBeUndefined()
    await expect(lifecycle.stop()).resolves.toBeUndefined()
  })
})

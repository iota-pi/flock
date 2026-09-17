import { ServiceLifecycleManager } from './ServiceLifecycleManager'

describe('ServiceLifecycleManager', () => {
  let lifecycle: ServiceLifecycleManager<{ clearLocalData?: boolean }>

  beforeEach(() => {
    lifecycle = new ServiceLifecycleManager('TestLifecycle')
  })

  it('starts services in FIFO order (registration order)', async () => {
    const startOrder: string[] = []

    lifecycle
      .register('ServiceA', {
        onStart: () => {
          startOrder.push('A')
        },
      })
      .register('ServiceB', {
        onStart: () => {
          startOrder.push('B')
        },
      })
      .register('ServiceC', {
        onStart: () => {
          startOrder.push('C')
        },
      })

    await lifecycle.start()

    expect(startOrder).toEqual(['A', 'B', 'C'])
    expect(lifecycle.isRunning()).toBe(true)
    expect(lifecycle.getStatus()).toBe('running')
  })

  it('stops services in LIFO order (reverse registration order)', async () => {
    const stopOrder: string[] = []

    lifecycle
      .register('ServiceA', {
        onStop: () => {
          stopOrder.push('A')
        },
      })
      .register('ServiceB', {
        onStop: () => {
          stopOrder.push('B')
        },
      })
      .register('ServiceC', {
        onStop: () => {
          stopOrder.push('C')
        },
      })

    await lifecycle.start()
    await lifecycle.stop()

    expect(stopOrder).toEqual(['C', 'B', 'A'])
    expect(lifecycle.getStatus()).toBe('stopped')
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
      .register('ServiceA', {
        onStop: () => {
          stopOrder.push('A')
        },
      })
      .register('ServiceB', {
        onStop: () => {
          stopOrder.push('B')
          throw new Error('ServiceB teardown explosion')
        },
      })
      .register('ServiceC', {
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
    expect(lifecycle.getStatus()).toBe('stopped')

    errorSpy.mockRestore()
  })

  it('rolls back already started services in LIFO order if startup fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const events: string[] = []

    lifecycle
      .register('ServiceA', {
        onStart: () => {
          events.push('start:A')
        },
        onStop: () => {
          events.push('stop:A')
        },
      })
      .register('ServiceB', {
        onStart: () => {
          events.push('start:B')
          throw new Error('ServiceB failed to start')
        },
        onStop: () => {
          events.push('stop:B')
        },
      })
      .register('ServiceC', {
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
    expect(lifecycle.getStatus()).toBe('errored')

    errorSpy.mockRestore()
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

    await lifecycle.start()
    expect(lifecycle.isRunning()).toBe(true)

    await lifecycle.stop()
    expect(lifecycle.getStatus()).toBe('stopped')
  })

  it('replaces registration when registering a service with an existing name', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    lifecycle.register('SameName', {})
    lifecycle.register('SameName', {})

    expect(lifecycle.getRegisteredServiceNames()).toEqual(['SameName'])
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('already registered'))

    warnSpy.mockRestore()
  })

  it('clears registered services and resets status', async () => {
    lifecycle.register('ServiceA', {})
    await lifecycle.start()
    await lifecycle.stop()

    lifecycle.clear()
    expect(lifecycle.getRegisteredServiceNames()).toEqual([])
    expect(lifecycle.getStatus()).toBe('uninitialized')
  })
})

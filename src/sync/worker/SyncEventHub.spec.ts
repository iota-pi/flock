import {
  EventHub,
  ClientEventHub,
  WorkerInternalEventHub,
  type ClientEvent,
  type WorkerInternalEvent,
} from './SyncEventHub'

describe('SyncEventHub', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  describe('EventHub<T>', () => {
    it('notifies registered listeners upon emit', () => {
      const hub = new EventHub<string>()
      const listener = vi.fn()

      hub.subscribe(listener)
      hub.emit('hello')

      expect(listener).toHaveBeenCalledWith('hello')
      expect(listener).toHaveBeenCalledTimes(1)
    })

    it('unsubscribes listeners when cleanup function is invoked', () => {
      const hub = new EventHub<string>()
      const listener = vi.fn()

      const unsubscribe = hub.subscribe(listener)
      hub.emit('first')
      expect(listener).toHaveBeenCalledWith('first')

      unsubscribe()
      hub.emit('second')
      expect(listener).toHaveBeenCalledTimes(1)
    })

    it('isolates synchronous listener errors and continues calling subsequent listeners', () => {
      const hub = new EventHub<string>('TestHub', 'test listener')
      const failingListener = vi.fn(() => {
        throw new Error('boom')
      })
      const successfulListener = vi.fn()

      hub.subscribe(failingListener)
      hub.subscribe(successfulListener)

      hub.emit('event')

      expect(failingListener).toHaveBeenCalledWith('event')
      expect(successfulListener).toHaveBeenCalledWith('event')
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '[TestHub] Error in test listener:',
        expect.any(Error)
      )
    })

    it('catches and logs rejected promises from async listeners', async () => {
      const hub = new EventHub<string>('AsyncHub', 'async listener')
      const rejectionError = new Error('async failure')
      const asyncListener = vi.fn(async () => {
        throw rejectionError
      })

      hub.subscribe(asyncListener)
      hub.emit('event')

      await vi.waitFor(() => {
        expect(consoleErrorSpy).toHaveBeenCalledWith(
          '[AsyncHub] Error in async listener:',
          rejectionError
        )
      })
    })
  })

  describe('ClientEventHub', () => {
    it('notifies local subscribers', () => {
      const hub = new ClientEventHub()
      const listener = vi.fn()

      hub.subscribe(listener)
      const event: ClientEvent = { type: 'ready' }
      hub.emit(event)

      expect(listener).toHaveBeenCalledWith(event)
    })

    it('forwards events to externalPort when set', () => {
      const hub = new ClientEventHub()
      const mockPort = {
        postMessage: vi.fn(),
      } as unknown as MessagePort

      hub.setExternalPort(mockPort)

      const event: ClientEvent = { type: 'ready' }
      hub.emit(event)

      expect(mockPort.postMessage).toHaveBeenCalledWith(event)
    })

    it('does not forward events when externalPort is null', () => {
      const hub = new ClientEventHub()
      hub.setExternalPort(null)

      expect(() => {
        hub.emit({ type: 'ready' })
      }).not.toThrow()
    })

    it('catches and logs error when externalPort.postMessage throws', () => {
      const hub = new ClientEventHub()
      const mockPort = {
        postMessage: vi.fn(() => {
          throw new Error('port disconnected')
        }),
      } as unknown as MessagePort

      hub.setExternalPort(mockPort)
      hub.emit({ type: 'ready' })

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '[ClientEventHub] Error posting to external port:',
        expect.any(Error)
      )
    })

    it('logs with [ClientEventHub] Error in local listener on local error', () => {
      const hub = new ClientEventHub()
      hub.subscribe(() => {
        throw new Error('local error')
      })

      hub.emit({ type: 'ready' })

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '[ClientEventHub] Error in local listener:',
        expect.any(Error)
      )
    })
  })

  describe('WorkerInternalEventHub', () => {
    it('notifies internal listeners of worker events', () => {
      const hub = new WorkerInternalEventHub()
      const listener = vi.fn()

      hub.subscribe(listener)
      const event: WorkerInternalEvent = { type: 'multipleLeadersDetected' }
      hub.emit(event)

      expect(listener).toHaveBeenCalledWith(event)
    })

    it('logs with [WorkerInternalEventHub] Error in listener on error and rethrows', () => {
      const hub = new WorkerInternalEventHub()
      hub.subscribe(() => {
        throw new Error('internal error')
      })

      expect(() => hub.emit({ type: 'soleLeaderRestored' })).toThrow('internal error')

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '[WorkerInternalEventHub] Error in listener:',
        expect.any(Error)
      )
    })
  })
})

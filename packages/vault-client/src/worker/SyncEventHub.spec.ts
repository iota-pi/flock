import { ClientEventHub, type ClientEvent } from './SyncEventHub'

describe('SyncEventHub', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
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

    it('unsubscribes listeners when cleanup function is invoked', () => {
      const hub = new ClientEventHub()
      const listener = vi.fn()

      const unsubscribe = hub.subscribe(listener)
      hub.emit({ type: 'ready' })
      unsubscribe()
      hub.emit({ type: 'ready' })

      expect(listener).toHaveBeenCalledTimes(1)
    })

    it('isolates synchronous listener errors and continues calling subsequent listeners', () => {
      const hub = new ClientEventHub()
      const failingListener = vi.fn(() => {
        throw new Error('boom')
      })
      const successfulListener = vi.fn()

      hub.subscribe(failingListener)
      hub.subscribe(successfulListener)
      hub.emit({ type: 'ready' })

      expect(failingListener).toHaveBeenCalled()
      expect(successfulListener).toHaveBeenCalled()
    })

    it('catches and logs rejected promises from async listeners', async () => {
      const hub = new ClientEventHub()
      const rejectionError = new Error('async failure')
      hub.subscribe(async () => {
        throw rejectionError
      })

      hub.emit({ type: 'ready' })

      await vi.waitFor(() => {
        expect(consoleErrorSpy).toHaveBeenCalledWith(
          '[ClientEventHub] Error in local listener:',
          rejectionError
        )
      })
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

})

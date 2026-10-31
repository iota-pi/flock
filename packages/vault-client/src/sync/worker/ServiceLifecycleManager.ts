import { createLogger, type Logger } from '../utils/logger'

export interface ServiceRegistration<TOptions = unknown> {
  name: string
  onStart?: () => Promise<void> | void
  onStop?: (options?: TOptions) => Promise<void> | void
}

type LifecycleStatus = 'uninitialized' | 'starting' | 'running' | 'stopping' | 'stopped' | 'errored'

/**
 * Manages standard initialization and teardown of dependent services.
 *
 * Guarantees:
 * 1. FIFO startup: services are initialized in the order they are registered.
 * 2. Automatic rollback on startup failure: if an `onStart` hook throws, already-started services
 *    are torn down in reverse order (LIFO) before the error is re-thrown.
 * 3. LIFO teardown: services are stopped in reverse order of registration.
 * 4. Teardown error isolation: failure in one service's `onStop` does not abort or skip
 *    the teardown of remaining services; each error is caught and logged.
 * 5. Idempotent shutdown: multiple calls to `stop()` are safe.
 * 6. A `stop()` during `start()` waits for it to finish, so no service starts after teardown.
 */
export class ServiceLifecycleManager<TOptions = unknown> {
  private readonly services: ServiceRegistration<TOptions>[] = []
  private startedServices: ServiceRegistration<TOptions>[] = []
  private status: LifecycleStatus = 'uninitialized'
  private startPromise: Promise<void> | null = null

  private readonly log: Logger

  constructor(contextName?: string) {
    this.log = createLogger(`ServiceLifecycleManager${contextName ? `:${contextName}` : ''}`)
  }

  public register(service: ServiceRegistration<TOptions>): this {
    this.services.push(service)
    return this
  }

  public async start(): Promise<void> {
    if (this.status === 'running') {
      return
    }
    if (this.startPromise) {
      return this.startPromise
    }
    const startPromise = this.runStart()
    this.startPromise = startPromise
    try {
      await startPromise
    } finally {
      if (this.startPromise === startPromise) {
        this.startPromise = null
      }
    }
  }

  private async runStart(): Promise<void> {
    this.status = 'starting'
    this.startedServices = []

    for (const service of this.services) {
      if (service.onStart) {
        try {
          await service.onStart()
          this.startedServices.push(service)
        } catch (err) {
          this.status = 'errored'
          this.log.error(`Error starting service "${service.name}":`, err)

          // Roll back already started services in LIFO order
          const rollbackServices = [...this.startedServices].reverse()
          for (const startedService of rollbackServices) {
            if (startedService.onStop) {
              try {
                await startedService.onStop()
              } catch (rollbackErr) {
                this.log.error(
                  `Error rolling back service "${startedService.name}":`,
                  rollbackErr
                )
              }
            }
          }
          this.startedServices = []
          throw err
        }
      } else {
        this.startedServices.push(service)
      }
    }

    this.status = 'running'
  }

  public async stop(options?: TOptions): Promise<void> {
    if (this.startPromise) {
      // A failed start has already rolled itself back
      await this.startPromise.catch(() => {})
    }
    if (this.status === 'stopping' || this.status === 'stopped') {
      return
    }

    this.status = 'stopping'

    // Teardown in reverse order of registration (LIFO)
    const reversedServices = [...this.services].reverse()

    for (const service of reversedServices) {
      if (service.onStop) {
        try {
          await service.onStop(options)
        } catch (err) {
          this.log.error(`Error stopping service "${service.name}":`, err)
        }
      }
    }

    this.startedServices = []
    this.status = 'stopped'
  }
}

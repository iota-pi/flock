import { AbortError } from '../utils/abort'
import { createLogger, type Logger } from '../utils/logger'

export interface ServiceRegistration<TOptions = unknown> {
  name: string
  onStart?: () => Promise<void> | void
  onStop?: (options?: TOptions) => Promise<void> | void
}

/**
 * Manages standard initialization and teardown of dependent services.
 *
 * A service is running from registration if it has no `onStart`, and otherwise once its `onStart`
 * succeeds. Only running services are stopped, each once.
 *
 * Guarantees:
 * 1. FIFO startup: services are initialized in the order they are registered.
 * 2. Automatic rollback on startup failure: if an `onStart` hook throws, the running services are
 *    stopped in reverse order (LIFO) before the error is re-thrown. A `stop()` waiting for the start
 *    stops them instead, with its options.
 * 3. LIFO teardown: services are stopped in reverse order of registration.
 * 4. Teardown error isolation: failure in one service's `onStop` does not abort or skip
 *    the teardown of remaining services; each error is caught and logged.
 * 5. Idempotent shutdown: multiple calls to `stop()` are safe.
 * 6. A `stop()` during `start()` waits for it to finish, and `start()` after `stop()` throws, so no
 *    service starts after teardown.
 */
export class ServiceLifecycleManager<TOptions = unknown> {
  private readonly services: ServiceRegistration<TOptions>[] = []
  private readonly running = new Set<ServiceRegistration<TOptions>>()
  private startPromise: Promise<void> | null = null
  private stopPromise: Promise<void> | null = null

  private readonly log: Logger

  constructor(contextName?: string) {
    this.log = createLogger(`ServiceLifecycleManager${contextName ? `:${contextName}` : ''}`)
  }

  public register(service: ServiceRegistration<TOptions>): this {
    this.services.push(service)
    if (!service.onStart) {
      this.running.add(service)
    }
    return this
  }

  /** Starts the services. It may be called once, before `stop()`. */
  public start(): Promise<void> {
    if (this.stopPromise) {
      return Promise.reject(new AbortError('The services were stopped before they started'))
    }
    if (this.startPromise) {
      return Promise.reject(new Error('The services have already been started'))
    }
    this.startPromise = this.runStart()
    return this.startPromise
  }

  private async runStart(): Promise<void> {
    for (const service of this.services) {
      if (!service.onStart) continue
      try {
        await service.onStart()
      } catch (err) {
        this.log.error(`Error starting service "${service.name}":`, err)
        // A stop waiting for this start stops the running services itself, with its options
        if (!this.stopPromise) {
          await this.stopRunning()
        }
        throw err
      }
      this.running.add(service)
    }
  }

  public stop(options?: TOptions): Promise<void> {
    this.stopPromise ??= this.runStop(options)
    return this.stopPromise
  }

  private async runStop(options?: TOptions): Promise<void> {
    // A start in progress finishes first, so no service starts after teardown
    await this.startPromise?.catch(() => {})
    await this.stopRunning(options)
  }

  /** Stops the running services in reverse order of registration (LIFO) */
  private async stopRunning(options?: TOptions): Promise<void> {
    for (const service of [...this.services].reverse()) {
      if (!this.running.delete(service)) continue
      try {
        await service.onStop?.(options)
      } catch (err) {
        this.log.error(`Error stopping service "${service.name}":`, err)
      }
    }
  }
}

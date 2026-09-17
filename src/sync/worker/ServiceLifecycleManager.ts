export type LifecycleHook = () => Promise<void> | void
export type LifecycleStopHook<TOptions = unknown> = (options?: TOptions) => Promise<void> | void

export interface ServiceRegistration<TOptions = unknown> {
  name: string
  onStart?: LifecycleHook
  onStop?: LifecycleStopHook<TOptions>
}

export type LifecycleStatus = 'uninitialized' | 'starting' | 'running' | 'stopping' | 'stopped' | 'errored'

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
 */
export class ServiceLifecycleManager<TOptions = unknown> {
  private services: ServiceRegistration<TOptions>[] = []
  private startedServices: ServiceRegistration<TOptions>[] = []
  private status: LifecycleStatus = 'uninitialized'

  constructor(private readonly contextName?: string) {}

  private get logPrefix(): string {
    return `[ServiceLifecycleManager${this.contextName ? `:${this.contextName}` : ''}]`
  }

  public register(service: ServiceRegistration<TOptions>): this
  public register(
    name: string,
    hooks: { onStart?: LifecycleHook; onStop?: LifecycleStopHook<TOptions> }
  ): this

  public register(
    serviceOrName: string | ServiceRegistration<TOptions>,
    hooks?: { onStart?: LifecycleHook; onStop?: LifecycleStopHook<TOptions> }
  ): this {
    const registration: ServiceRegistration<TOptions> =
      typeof serviceOrName === 'string'
        ? { name: serviceOrName, onStart: hooks?.onStart, onStop: hooks?.onStop }
        : serviceOrName

    const existing = this.services.find(s => s.name === registration.name)
    if (existing) {
      console.warn(`${this.logPrefix} Service "${registration.name}" already registered. Replacing registration.`)
      const index = this.services.indexOf(existing)
      this.services[index] = registration
    } else {
      this.services.push(registration)
    }

    return this
  }

  public async start(): Promise<void> {
    if (this.status === 'running') {
      return
    }

    this.status = 'starting'
    this.startedServices = []

    for (const service of this.services) {
      if (service.onStart) {
        try {
          await service.onStart()
          this.startedServices.push(service)
        } catch (err) {
          this.status = 'errored'
          console.error(`${this.logPrefix} Error starting service "${service.name}":`, err)

          // Roll back already started services in LIFO order
          const rollbackServices = [...this.startedServices].reverse()
          for (const startedService of rollbackServices) {
            if (startedService.onStop) {
              try {
                await startedService.onStop()
              } catch (rollbackErr) {
                console.error(
                  `${this.logPrefix} Error rolling back service "${startedService.name}":`,
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
          console.error(`${this.logPrefix} Error stopping service "${service.name}":`, err)
        }
      }
    }

    this.startedServices = []
    this.status = 'stopped'
  }

  public getStatus(): LifecycleStatus {
    return this.status
  }

  public isRunning(): boolean {
    return this.status === 'running'
  }

  public getRegisteredServiceNames(): string[] {
    return this.services.map(s => s.name)
  }

  public clear(): void {
    if (this.status === 'running' || this.status === 'starting' || this.status === 'stopping') {
      console.warn(`${this.logPrefix} Clearing services while lifecycle is active (${this.status}).`)
    }
    this.services = []
    this.startedServices = []
    this.status = 'uninitialized'
  }
}

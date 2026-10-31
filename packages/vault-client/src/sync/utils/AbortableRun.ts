import { checkAlive } from './abort'

/**
 * Gives each run of an operation its own AbortSignal and keeps the latest one abortable from outside,
 * for components whose work must stop when they go offline, lose leadership or shut down.
 *
 * A run throws an AbortError if it starts while not alive, or if it fails once its signal has aborted
 * or it is no longer alive, so callers can treat any error after an abort as the abort itself.
 */
export class AbortableRun {
  private controller: AbortController | null = null
  private readonly isAlive: () => boolean

  constructor(isAlive: () => boolean = () => true) {
    this.isAlive = isAlive
  }

  get isRunning(): boolean {
    return this.controller !== null
  }

  /**
   * Runs `fn` with a fresh signal, which also aborts with `outerSignal` when one is given.
   * Starting a run while another is in progress replaces it as the one `abort` stops.
   */
  async run<T>(fn: (signal: AbortSignal) => Promise<T>, outerSignal?: AbortSignal): Promise<T> {
    const controller = new AbortController()
    this.controller = controller
    const signal = outerSignal ? AbortSignal.any([controller.signal, outerSignal]) : controller.signal

    try {
      checkAlive(signal, this.isAlive)
      return await fn(signal)
    } catch (err) {
      checkAlive(signal, this.isAlive)
      throw err
    } finally {
      if (this.controller === controller) {
        this.controller = null
      }
    }
  }

  /** Aborts the current run, if there is one */
  abort(): void {
    if (this.controller) {
      this.controller.abort()
      this.controller = null
    }
  }
}

import { fireAndForget } from './fireAndForget'
import { createLogger } from './logger'

const log = createLogger('AsyncQueue')

/**
 * A FIFO queue that runs `worker` on one item at a time. A worker error is
 * logged and the queue moves on to the next item.
 */
export class AsyncQueue<T> {
  private items: T[] = []
  private isProcessing = false

  constructor(private readonly worker: (item: T) => Promise<void> | void) {}

  push(...items: T[]): void {
    if (items.length === 0) return
    this.items.push(...items)
    fireAndForget(this.drain(), 'AsyncQueue:drain')
  }

  /** Drops the items not yet started. An item already running finishes. */
  clear(): void {
    this.items = []
  }

  private async drain(): Promise<void> {
    if (this.isProcessing) {
      return
    }
    this.isProcessing = true

    try {
      while (this.items.length > 0) {
        const item = this.items.shift()!
        try {
          await this.worker(item)
        } catch (err) {
          log.error('Unhandled error in queue worker:', err)
        }
      }
    } finally {
      this.isProcessing = false
    }
  }
}

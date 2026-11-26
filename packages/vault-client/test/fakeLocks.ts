interface Holder {
  /** Rejects the holder's request, as a steal does */
  abort: (error: unknown) => void
}

interface Waiter {
  grant: () => void
}

/**
 * An in-memory `navigator.locks` with the parts the active-tab lock uses: exclusive locks, `ifAvailable`,
 * `steal` and `query`. A steal rejects the holder's request with an `AbortError` and is granted at
 * once, ahead of any queued request, as in browsers.
 */
export class FakeLockManager {
  private readonly holders = new Map<string, Holder>()
  private readonly queues = new Map<string, Waiter[]>()

  request<T>(
    name: string,
    optionsOrCallback: LockOptions | ((lock: Lock | null) => T | Promise<T>),
    maybeCallback?: (lock: Lock | null) => T | Promise<T>,
  ): Promise<T> {
    const options: LockOptions = typeof optionsOrCallback === 'function' ? {} : optionsOrCallback
    const callback = (typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback)!
    const queue = this.queues.get(name) ?? []
    this.queues.set(name, queue)

    if (options.steal) {
      this.holders.get(name)?.abort(new DOMException('The lock was stolen', 'AbortError'))
      this.holders.delete(name)
      return this.grant(name, callback)
    }
    if (options.ifAvailable && (this.holders.has(name) || queue.length > 0)) {
      return Promise.resolve(callback(null))
    }
    if (!this.holders.has(name)) {
      return this.grant(name, callback)
    }
    return new Promise<T>((resolve, reject) => {
      queue.push({ grant: () => this.grant(name, callback).then(resolve, reject) })
    })
  }

  async query(): Promise<LockManagerSnapshot> {
    return {
      held: [...this.holders.keys()].map(name => ({ name, mode: 'exclusive' as const })),
      pending: [...this.queues].flatMap(([name, queue]) => queue.map(() => ({ name, mode: 'exclusive' as const }))),
    }
  }

  /** Whether a lock of this name is held */
  isHeld(name: string): boolean {
    return this.holders.has(name)
  }

  private grant<T>(name: string, callback: (lock: Lock | null) => T | Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const holder: Holder = { abort: reject }
      this.holders.set(name, holder)
      const release = () => {
        if (this.holders.get(name) !== holder) return
        this.holders.delete(name)
        this.queues.get(name)?.shift()?.grant()
      }
      Promise.resolve()
        .then(() => callback({ name, mode: 'exclusive' } as Lock))
        .then(
          value => {
            release()
            resolve(value)
          },
          (error: unknown) => {
            release()
            reject(error)
          },
        )
    })
  }
}

/** Puts a fake lock manager in `navigator.locks` and returns it, with a function that puts back what was there */
export function installFakeLocks(): { locks: FakeLockManager, restore: () => void } {
  const locks = new FakeLockManager()
  const original = Object.getOwnPropertyDescriptor(navigator, 'locks')
  Object.defineProperty(navigator, 'locks', { value: locks, configurable: true, writable: true })
  return {
    locks,
    restore: () => {
      if (original) {
        Object.defineProperty(navigator, 'locks', original)
      } else {
        delete (navigator as { locks?: LockManager }).locks
      }
    },
  }
}

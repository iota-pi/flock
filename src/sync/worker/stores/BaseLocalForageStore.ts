import localforage from 'localforage'
import { runStorageOperation, type RunStorageOperationOptions } from '../../../utils/storageManager'

export interface BaseStoreOptions {
  name: string
  storeName: string
  driver?: string | string[]
  description?: string
}

export abstract class BaseLocalForageStore {
  protected readonly store: LocalForage
  public readonly storeName: string

  constructor(optionsOrInstance: BaseStoreOptions | LocalForage) {
    if ('getItem' in optionsOrInstance && typeof (optionsOrInstance as LocalForage).getItem === 'function') {
      this.store = optionsOrInstance as LocalForage
      this.storeName = (optionsOrInstance as any)._config?.storeName ?? ''
    } else {
      const options = optionsOrInstance as BaseStoreOptions
      this.storeName = options.storeName
      this.store = localforage.createInstance(options)
    }
  }

  protected async getItem<T>(key: string): Promise<T | null> {
    return this.store.getItem<T>(key)
  }

  protected async setItem<T>(
    key: string,
    value: T,
    options?: RunStorageOperationOptions
  ): Promise<T> {
    return runStorageOperation(() => this.store.setItem(key, value), options)
  }

  protected async removeItem(
    key: string,
    options?: RunStorageOperationOptions
  ): Promise<void> {
    return runStorageOperation(() => this.store.removeItem(key), options)
  }

  async clear(options?: RunStorageOperationOptions): Promise<void> {
    return runStorageOperation(() => this.store.clear(), options)
  }

  async length(): Promise<number> {
    return this.store.length()
  }

  async keys(): Promise<string[]> {
    return this.store.keys()
  }

  protected async iterate<T, U>(
    iteratee: (value: T, key: string, iterationNumber: number) => U
  ): Promise<U> {
    return this.store.iterate(iteratee)
  }

  /**
   * Probes storage availability by writing and removing a temporary key.
   * Intercepts and surfaces QuotaExceededError if storage quota is full.
   */
  async testStorageAvailable(): Promise<boolean> {
    const probeKey = '__quota_probe__'
    await runStorageOperation(
      async () => {
        await this.store.setItem(probeKey, Date.now())
        await this.store.removeItem(probeKey)
      },
      { retryOnQuotaError: false }
    )
    return true
  }
}

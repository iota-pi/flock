import { syncDB } from '../api/db'

type StorageAdapter = {
  getItem: <T>(key: string) => Promise<T | null>
  setItem: <T>(key: string, value: T) => Promise<unknown>
  removeItem: (key: string) => Promise<void>
}

const defaultAdapter: StorageAdapter = {
  getItem: key => syncDB.getItem(key),
  setItem: (key, value) => syncDB.setItem(key, value),
  removeItem: key => syncDB.removeItem(key),
}

export class PersistedQueueStorage<T> {
  private readonly key: string
  private readonly adapter: StorageAdapter

  constructor(key: string, adapter: StorageAdapter = defaultAdapter) {
    this.key = key
    this.adapter = adapter
  }

  async read(): Promise<T[]> {
    return (await this.adapter.getItem<T[]>(this.key)) || []
  }

  async write(items: T[]): Promise<void> {
    await this.adapter.setItem(this.key, items)
  }

  async clear(): Promise<void> {
    await this.adapter.removeItem(this.key)
  }
}
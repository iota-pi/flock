import { describe, it, expect, beforeEach, vi } from 'vitest'
import { SyncedHeadsStore } from './SyncedHeadsStore'
import type { DocumentId } from '@automerge/automerge-repo/slim'

class MockLocalforage {
  private data = new Map<string, any>()

  async getItem<T>(key: string): Promise<T | null> {
    return (this.data.get(key) as T) ?? null
  }

  async setItem<T>(key: string, value: T): Promise<T> {
    this.data.set(key, value)
    return value
  }

  async clear(): Promise<void> {
    this.data.clear()
  }
}

let activeStore: MockLocalforage
vi.mock('localforage', () => ({
  default: {
    createInstance: vi.fn().mockImplementation(() => {
      activeStore = new MockLocalforage()
      return activeStore
    }),
  },
}))

vi.mock('../../../utils/storageManager', () => ({
  runStorageOperation: vi.fn(async (op: () => Promise<any>) => op()),
}))

describe('SyncedHeadsStore', () => {
  let store: SyncedHeadsStore

  beforeEach(() => {
    store = new SyncedHeadsStore('account-1')
  })

  it('saves and loads synced heads correctly', async () => {
    const input: [DocumentId, string[]][] = [
      ['doc-1' as DocumentId, ['head-1a', 'head-1b']],
      ['doc-2' as DocumentId, ['head-2a']],
    ]

    await store.saveSyncedHeads(input)
    const loaded = await store.loadSyncedHeads()

    expect(loaded).toEqual([
      ['doc-1', ['head-1a', 'head-1b']],
      ['doc-2', ['head-2a']],
    ])
  })

  it('returns null when storage is empty', async () => {
    const loaded = await store.loadSyncedHeads()
    expect(loaded).toBeNull()
  })

  it('clears storage', async () => {
    await store.saveSyncedHeads([['doc-1' as DocumentId, ['head-1']]])
    await store.clear()

    const loaded = await store.loadSyncedHeads()
    expect(loaded).toBeNull()
  })

  it('handles invalid data format gracefully', async () => {
    await activeStore.setItem('syncedHeadsByDocId', 'corrupted-data')
    const loaded = await store.loadSyncedHeads()
    expect(loaded).toBeNull()
  })
})

import type { Item } from '../../state/items'
import { syncDB } from '../db'
import {
  setCachedAutomergeBinary,
  setCachedMetadataAutomergeBinary,
} from '../../sync/automergeBinaryCache'

const DECRYPTION_CACHE_KEY_PREFIX = 'decryption-cache'
const MAX_DECRYPTION_CACHE_ITEMS = 2000
const PERSIST_DEBOUNCE_MS = 200

export type DecryptionCacheEntry = {
  cacheKey: string
  item: Item
  automergeBinary?: Uint8Array
}

function getStorageKey(accountId: string): string {
  return `${DECRYPTION_CACHE_KEY_PREFIX}_${accountId}`
}

function isCacheEntry(value: unknown): value is DecryptionCacheEntry {
  if (!value || typeof value !== 'object') {
    return false
  }

  const candidate = value as Partial<DecryptionCacheEntry>
  return typeof candidate.cacheKey === 'string' && !!candidate.item && typeof candidate.item === 'object'
}

export class DecryptionCache {
  private readonly entries = new Map<string, DecryptionCacheEntry>()
  private loadedAccountId: string | null = null
  private writeTimer: ReturnType<typeof setTimeout> | null = null
  private metadataBinary: Uint8Array | null = null

  async load(accountId: string): Promise<void> {
    if (this.loadedAccountId === accountId) {
      return
    }

    const persisted = await syncDB.getItem<Record<string, unknown>>(getStorageKey(accountId))
    this.entries.clear()

    if (persisted) {
      for (const [key, value] of Object.entries(persisted)) {
        if (isCacheEntry(value)) {
          this.entries.set(key, value)
          if (value.automergeBinary instanceof Uint8Array) {
            setCachedAutomergeBinary(key, value.automergeBinary)
          }
        }
      }
    }

    this.loadedAccountId = accountId
  }

  get(itemId: string): DecryptionCacheEntry | undefined {
    return this.entries.get(itemId)
  }

  set(itemId: string, value: DecryptionCacheEntry): void {
    this.entries.set(itemId, value)
    if (value.automergeBinary instanceof Uint8Array) {
      setCachedAutomergeBinary(itemId, value.automergeBinary)
    }
  }

  setMetadataBinary(binary: Uint8Array): void {
    this.metadataBinary = binary
    setCachedMetadataAutomergeBinary(binary)
  }

  getMetadataBinary(): Uint8Array | null {
    return this.metadataBinary
  }

  delete(itemId: string): void {
    this.entries.delete(itemId)
  }

  schedulePersist(accountId: string): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer)
    }

    this.writeTimer = setTimeout(() => {
      if (this.entries.size > MAX_DECRYPTION_CACHE_ITEMS) {
        const newestEntries = Array.from(this.entries.entries()).slice(-MAX_DECRYPTION_CACHE_ITEMS)
        this.entries.clear()
        for (const [itemId, entry] of newestEntries) {
          this.entries.set(itemId, entry)
        }
      }

      const snapshot = Object.fromEntries(this.entries.entries())
      void syncDB.setItem(getStorageKey(accountId), snapshot)
    }, PERSIST_DEBOUNCE_MS)
  }

  getSnapshot(): Map<string, DecryptionCacheEntry> {
    return new Map(this.entries)
  }

  reset(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer)
    }

    this.writeTimer = null
    this.loadedAccountId = null
    this.metadataBinary = null
    this.entries.clear()
  }
}

export const sharedDecryptionCache = new DecryptionCache()

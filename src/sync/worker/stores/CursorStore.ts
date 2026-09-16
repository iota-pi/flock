import type { ItemId } from 'src/shared/schemas/items'
import {
  ScopedMetadataStore,
  SYNC_METADATA_KEYS,
  LEGACY_DB_NAMES,
  LEGACY_KEYS,
} from './syncMetadataStorage'

export interface PersistedSyncCursors {
  globalCursor: number
  retries?: [ItemId, number][]
}

/**
 * Normalizes an array of [ItemId, cursor] entries into a PersistedSyncCursors object.
 * Uses an iterative loop instead of Math.max(...spread) to avoid RangeError: Maximum call stack size exceeded.
 */
export function normalizeCursors(raw: [ItemId, number][]): PersistedSyncCursors {
  let max = 0
  const retries: [ItemId, number][] = []

  for (const entry of raw) {
    if (Array.isArray(entry) && entry.length >= 2) {
      const [itemId, c] = entry
      if (typeof c === 'number' && Number.isFinite(c) && c >= 0) {
        if (c > max) {
          max = c
        }
        retries.push([itemId, c])
      }
    }
  }

  return {
    globalCursor: max,
    retries,
  }
}

export class CursorStore extends ScopedMetadataStore<PersistedSyncCursors> {
  constructor(accountIdOrStore: string | LocalForage) {
    super(accountIdOrStore, {
      metadataKey: SYNC_METADATA_KEYS.CURSORS,
      legacyKey: LEGACY_KEYS.CURSORS,
      legacyDbName: LEGACY_DB_NAMES.CURSORS,
      legacyStorePrefix: 'cursors',
      storeLabel: 'CursorStore',
      normalize: (raw: unknown): PersistedSyncCursors | null => {
        if (Array.isArray(raw)) {
          return normalizeCursors(raw as [ItemId, number][])
        }
        if (raw && typeof raw === 'object' && 'globalCursor' in raw) {
          return raw as PersistedSyncCursors
        }
        return null
      },
      shouldUpgradeInPlace: (raw: unknown) => Array.isArray(raw),
    })
  }

  async loadCursors(): Promise<PersistedSyncCursors | null> {
    return this.getScopedData()
  }

  async saveCursors(state: PersistedSyncCursors | [ItemId, number][]): Promise<void> {
    const data = Array.isArray(state) ? normalizeCursors(state) : state
    await this.setScopedData(data)
  }
}

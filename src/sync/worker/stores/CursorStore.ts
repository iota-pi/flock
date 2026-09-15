import localforage from 'localforage'
import type { ItemId } from 'src/shared/schemas/items'
import { BaseLocalForageStore } from './BaseLocalForageStore'
import {
  getSyncMetadataStorage,
  hasLegacyDatabase,
  SYNC_METADATA_KEYS,
  LEGACY_DB_NAMES,
  LEGACY_KEYS,
} from './syncMetadataStorage'
import type { RunStorageOperationOptions } from '../../../utils/storageManager'

export interface PersistedSyncCursors {
  globalCursor: number
  retries?: [ItemId, number][]
}

export class CursorStore extends BaseLocalForageStore {
  private readonly accountId: string | null

  constructor(accountIdOrStore: string | LocalForage) {
    if (typeof accountIdOrStore === 'string') {
      super(getSyncMetadataStorage(accountIdOrStore))
      this.accountId = accountIdOrStore
    } else {
      super(accountIdOrStore)
      this.accountId = null
    }
  }

  async loadCursors(): Promise<PersistedSyncCursors | null> {
    const raw = await this.getItem<PersistedSyncCursors | [ItemId, number][]>(SYNC_METADATA_KEYS.CURSORS)
    if (raw !== null) {
      if (Array.isArray(raw)) {
        const max = Math.max(0, ...raw.map(([, c]) => (Number.isFinite(c) ? c : 0)))
        const migrated: PersistedSyncCursors = {
          globalCursor: max,
          retries: raw.filter(([, c]) => Number.isFinite(c) && c >= 0),
        }
        await this.saveCursors(migrated)
        return migrated
      }
      return raw
    }

    return this.migrateLegacyCursors()
  }

  async saveCursors(state: PersistedSyncCursors | [ItemId, number][]): Promise<void> {
    if (Array.isArray(state)) {
      const max = Math.max(0, ...state.map(([, c]) => (Number.isFinite(c) ? c : 0)))
      await this.setItem(SYNC_METADATA_KEYS.CURSORS, {
        globalCursor: max,
        retries: state.filter(([, c]) => Number.isFinite(c) && c >= 0),
      })
    } else {
      await this.setItem(SYNC_METADATA_KEYS.CURSORS, state)
    }
  }

  override async clear(options?: RunStorageOperationOptions): Promise<void> {
    await this.removeItem(SYNC_METADATA_KEYS.CURSORS, options)
    await this.removeItem(LEGACY_KEYS.CURSORS, options).catch(() => {})
  }

  private async migrateLegacyCursors(): Promise<PersistedSyncCursors | null> {
    // 1. Check in-store legacy key
    const inStoreLegacy = await this.getItem<[ItemId, number][]>(LEGACY_KEYS.CURSORS)
    if (inStoreLegacy && Array.isArray(inStoreLegacy)) {
      const max = Math.max(0, ...inStoreLegacy.map(([, c]) => (Number.isFinite(c) ? c : 0)))
      const migrated: PersistedSyncCursors = {
        globalCursor: max,
        retries: inStoreLegacy.filter(([, c]) => Number.isFinite(c) && c >= 0),
      }
      await this.saveCursors(migrated)
      await this.removeItem(LEGACY_KEYS.CURSORS).catch(() => {})
      return migrated
    }

    // 2. Check legacy database
    if (this.accountId) {
      try {
        const hasLegacy = await hasLegacyDatabase(LEGACY_DB_NAMES.CURSORS)
        if (hasLegacy) {
          const legacyStore = localforage.createInstance({
            name: LEGACY_DB_NAMES.CURSORS,
            storeName: `cursors-${this.accountId}`,
          })
          const legacyData = await legacyStore.getItem<[ItemId, number][]>(LEGACY_KEYS.CURSORS)
          if (legacyData && Array.isArray(legacyData)) {
            const max = Math.max(0, ...legacyData.map(([, c]) => (Number.isFinite(c) ? c : 0)))
            const migrated: PersistedSyncCursors = {
              globalCursor: max,
              retries: legacyData.filter(([, c]) => Number.isFinite(c) && c >= 0),
            }
            await this.saveCursors(migrated)
            await legacyStore.removeItem(LEGACY_KEYS.CURSORS).catch(() => {})
            return migrated
          }
        }
      } catch (err) {
        console.warn('[CursorStore] Failed to migrate legacy cursors:', err)
      }
    }

    return null
  }
}

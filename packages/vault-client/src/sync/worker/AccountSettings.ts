import deepEqual from 'fast-deep-equal'
import type { VaultMetadata } from '../shared/types'
import { settingsDocId, type ItemId } from '@vault/shared'
import type { AutomergeDocStore, AutomergeIndexManager, RepoDoc } from './docStore'
import type { ClientEventHub } from './SyncEventHub'
import type { DocCodec, LegacySettingsContext, LegacySettingsSource } from './domain'
import { reconcileAutomergeList } from './utils/crdtReconcile'
import { isPlainObject } from './utils/objectUtils'
import { publishRealtimeBusSyncPing } from './realtimeBus'
import { createLogger } from '../utils/logger'

const log = createLogger('AccountSettings')

export interface AccountSettingsDeps {
  accountId: string
  docStore: AutomergeDocStore
  indexManager: AutomergeIndexManager
  eventHub: ClientEventHub
  markDocumentDirty: (itemId: ItemId) => void
  syncedKeys?: readonly string[]
  legacySettings?: LegacySettingsSource
  withAuth: LegacySettingsContext['withAuth']
}

function pickKeys(metadata: VaultMetadata | null | undefined, keys: ReadonlySet<string>): VaultMetadata {
  const result: VaultMetadata = {}
  for (const [key, value] of Object.entries(metadata ?? {})) {
    if (keys.has(key) && value !== undefined) {
      result[key] = value
    }
  }
  return result
}

/** Writes `value` into `draft[key]`, editing nested maps and lists in place so concurrent edits merge */
function writeDraftValue(draft: Record<string, unknown>, key: string, value: unknown): void {
  const current = draft[key]
  if (value === undefined) {
    delete draft[key]
  } else if (isPlainObject(value) && isPlainObject(current)) {
    for (const nestedKey of Object.keys(current)) {
      if (!(nestedKey in value)) {
        delete current[nestedKey]
      }
    }
    for (const [nestedKey, nestedValue] of Object.entries(value)) {
      if (!deepEqual(current[nestedKey], nestedValue)) {
        writeDraftValue(current, nestedKey, nestedValue)
      }
    }
  } else if (Array.isArray(value) && Array.isArray(current)) {
    reconcileAutomergeList(current, value)
  } else {
    draft[key] = value
  }
}

/**
 * Keeps the settings document out of the app's codec. It holds plain settings, not app documents.
 */
export function withSettingsDocPassthrough(codec: DocCodec, accountId: string): DocCodec {
  const docId = settingsDocId(accountId)
  return {
    decode: (id, raw) => (id === docId ? { ...raw, id } : codec.decode(id, raw)),
    isCorrupt: doc => doc.id !== docId && codec.isCorrupt(doc),
  }
}

/**
 * Account metadata as the app sees it. Keys listed in `syncedKeys` live in an encrypted settings
 * document with a fixed per-account ID, which syncs like any other document (snapshots, WAL,
 * manifest, key rotation). Other keys stay in the device's local index.
 *
 * The settings document is created on the first write, never seeded with defaults, and is never
 * deleted or recreated under a new ID.
 */
export class AccountSettings {
  readonly docId: ItemId
  private readonly syncedKeys: ReadonlySet<string>
  private localMetadata: VaultMetadata = {}
  private settings: VaultMetadata = {}

  constructor(private readonly deps: AccountSettingsDeps) {
    this.docId = settingsDocId(deps.accountId)
    this.syncedKeys = new Set(deps.syncedKeys ?? [])
  }

  isSettingsDoc(itemId: ItemId | string): boolean {
    return itemId === this.docId
  }

  getMetadata(): VaultMetadata {
    return { ...this.localMetadata, ...this.settings }
  }

  /**
   * Reads both halves from storage and emits the combined metadata. If the settings document can't
   * be read yet, its change listener emits it once the worker subscribes to it.
   */
  async load(): Promise<void> {
    this.localMetadata = await this.deps.indexManager.getAutomergeMetadata()
    try {
      this.settings = await this.readSettings()
    } catch (err) {
      log.warn('Failed to read the settings document:', err)
    }
    this.emit()
  }

  handleLocalMetadata(metadata: VaultMetadata): void {
    this.localMetadata = metadata
    this.emit()
  }

  handleSettingsDoc(doc: RepoDoc | null | undefined): void {
    this.settings = this.toSettings(doc)
    this.emit()
  }

  async mutate(changes: Partial<VaultMetadata>): Promise<void> {
    try {
      const synced: VaultMetadata = {}
      const local: VaultMetadata = {}
      for (const [key, value] of Object.entries(changes)) {
        if (this.syncedKeys.has(key)) {
          synced[key] = value
        } else {
          local[key] = value
        }
      }

      if (Object.keys(synced).length > 0) {
        await this.writeSettings(synced)
      }
      if (Object.keys(local).length > 0) {
        await this.deps.indexManager.updateAutomergeMetadata(local)
      }
    } catch (err) {
      this.deps.eventHub.emit({ type: 'mutationFailed', mutationType: 'metadata', error: (err as Error).message })
      this.emit()
    }
  }

  /**
   * Moves synced settings that predate the settings document into it: first from the legacy
   * source, then from this device's local metadata. Keys the document already has win, because
   * another device migrated them first. Runs after each manifest sync so that the server's
   * settings document, if there is one, has been hydrated first. Safe to repeat after a failure.
   */
  async migrateLegacySettings(): Promise<void> {
    if (this.syncedKeys.size === 0) return

    const localMetadata = await this.deps.indexManager.getAutomergeMetadata()
    const localLegacy = pickKeys(localMetadata, this.syncedKeys)
    const context: LegacySettingsContext = { accountId: this.deps.accountId, withAuth: this.deps.withAuth }
    const source = this.deps.legacySettings
    const legacy = source ? await source.load(localMetadata, context) : localLegacy

    const toMigrate = pickKeys(legacy, this.syncedKeys)
    if (Object.keys(toMigrate).length > 0) {
      const current = await this.readSettings()
      const missing = Object.fromEntries(
        Object.entries(toMigrate).filter(([key]) => current[key] === undefined),
      )
      if (Object.keys(missing).length > 0) {
        await this.writeSettings(missing)
      }
    }
    if (legacy && source) {
      await source.clear(context)
    }

    const staleKeys = [...Object.keys(localLegacy), ...(source?.obsoleteLocalKeys ?? [])]
      .filter(key => key in localMetadata)
    if (staleKeys.length > 0) {
      await this.deps.indexManager.removeMetadataKeys(staleKeys)
    }
  }

  private async writeSettings(changes: VaultMetadata): Promise<void> {
    const current = await this.readSettings()
    const changed = Object.entries(changes).filter(([key, value]) => !deepEqual(current[key], value))
    if (changed.length === 0) return

    const applied = await this.deps.docStore.changeDocument(
      this.docId,
      draft => {
        for (const [key, value] of changed) {
          writeDraftValue(draft, key, value)
        }
      },
      { createIfMissing: true },
    )
    if (!applied) {
      throw new Error('Failed to write the settings document')
    }

    await this.deps.indexManager.addAutomergeItemIdsToIndex([this.docId])
    this.deps.markDocumentDirty(this.docId)
    publishRealtimeBusSyncPing(this.deps.accountId, [this.docId])
    this.settings = await this.readSettings()
    this.emit()
  }

  private async readSettings(): Promise<VaultMetadata> {
    return this.toSettings(await this.deps.docStore.readItemSnapshot(this.docId))
  }

  private toSettings(doc: RepoDoc | null | undefined): VaultMetadata {
    return pickKeys(doc, this.syncedKeys)
  }

  private emit(): void {
    this.deps.eventHub.emit({ type: 'metadataUpdated', metadata: this.getMetadata() })
  }
}

import type { AccountMetadata } from '../state/metadata'
import type { ItemId } from '../shared/itemTypes'

export type BackupSyncState = {
  cursors: [string, number][]
  pendingSync: [string, string[]][]
  lastModified: [string, number][]
}

export type BackupPayloadV2 = {
  version: 2
  metadata?: AccountMetadata
  documents: Partial<Record<ItemId, string>>
} & Partial<BackupSyncState>

export type RestorePayload = BackupPayloadV2

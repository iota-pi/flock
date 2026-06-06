import { ItemId } from 'src/shared/schemas/items'
import type { AccountMetadata } from '../state/metadata'


export type BackupSyncState = {
  cursors: [ItemId, number][]
  pendingSync: [ItemId, string[]][]
  lastModified: [ItemId, number][]
}

export type BackupPayloadV2 = {
  version: 2
  metadata?: AccountMetadata
  documents: Partial<Record<ItemId, string>>
} & Partial<BackupSyncState>

export type RestorePayload = BackupPayloadV2

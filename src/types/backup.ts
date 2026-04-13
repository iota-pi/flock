import type { AccountMetadata } from '../state/metadata'
import type { ItemId } from '../shared/itemTypes'

export type BackupPayloadV2 = {
  version: 2
  metadata?: AccountMetadata
  documents: Partial<Record<ItemId, string>>
}

export type RestorePayload = BackupPayloadV2

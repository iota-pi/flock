import type { Item } from '../state/items'
import type { AccountMetadata } from '../state/metadata'
import type { QueuedMutation } from '../sync/offlineQueueStore'

export type BackupPayloadV1 = {
  version: 1
  metadata?: AccountMetadata
  items: Item[]
  offlineQueue: QueuedMutation[]
  deadLetterQueue: QueuedMutation[]
}

export type DecryptedBackupPayload = BackupPayloadV1 | Item[]

export type RestorePayload = {
  metadata?: AccountMetadata
  items: Item[]
  offlineQueue: QueuedMutation[]
  deadLetterQueue: QueuedMutation[]
}

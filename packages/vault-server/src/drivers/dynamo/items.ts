import { MAX_ITEM_SIZE } from '@vault/shared'
import type { VaultItem } from '../base'

/**
 * Validates a VaultItem.
 * Supports both legacy cipher and snapshot format
 * - Legacy: must have cipher and iv
 * - Snapshot: must have snapshot payload or external storage pointer
 * - Tombstone: needs no payload
 */
export function validateItem(item: VaultItem) {
  const isTombstone = item.metadata.deleted === true
  const isLegacy = !!item.cipher
  const isSnapshot = !!item.snapshot

  const hasValidPayload = isTombstone
    || (isLegacy ? !!item.metadata.iv : isSnapshot)

  if (!hasValidPayload) {
    throw new Error(
      `Invalid item format: must be either legacy (cipher+iv) or snapshot. Item: ${JSON.stringify(item)}`,
    )
  }

  // Calculate item length without expanding binary Buffers into huge JSON arrays
  let itemLength: number
  const cipher = item.snapshot?.cipher
  if (cipher && (Buffer.isBuffer(cipher) || cipher instanceof Uint8Array)) {
    const cipherLength = cipher.byteLength
    const itemWithoutCipher = {
      ...item,
      snapshot: {
        ...item.snapshot,
        cipher: undefined,
      },
    }
    itemLength = JSON.stringify(itemWithoutCipher).length + cipherLength
  } else {
    itemLength = JSON.stringify(item).length
  }

  if (itemLength > MAX_ITEM_SIZE) {
    throw new Error(`Item length (${itemLength}) exceeds maximum (${MAX_ITEM_SIZE})`)
  }
}

/**
 * The item as it is stored, with its snapshot ciphertext inline as binary (DynamoDB type 'B').
 * Clients send it as base64.
 */
export function toStoredItem(item: VaultItem): VaultItem {
  if (!item.snapshot?.cipher) {
    return item
  }
  const cipherBytes = typeof item.snapshot.cipher === 'string'
    ? Buffer.from(item.snapshot.cipher, 'base64')
    : Buffer.from(item.snapshot.cipher)
  return {
    ...item,
    snapshot: {
      iv: item.snapshot.iv,
      kver: item.snapshot.kver,
      ...(item.snapshot.format === undefined ? {} : { format: item.snapshot.format }),
      cipher: cipherBytes,
    },
  }
}

/** Turns a stored item's binary snapshot ciphertext back into the base64 clients read, in place */
export function decodeStoredSnapshotCipher(record: VaultItem): void {
  const cipher = record.snapshot?.cipher
  if (cipher && (Buffer.isBuffer(cipher) || cipher instanceof Uint8Array)) {
    record.snapshot!.cipher = Buffer.from(cipher).toString('base64')
  }
}

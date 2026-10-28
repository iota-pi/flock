import { MAX_ITEM_SIZE } from '@vault/shared'
import type { FetchedVaultItem, VaultItem } from '../vaultDriver'

/**
 * Throws unless the item has a payload and fits in MAX_ITEM_SIZE (measuring a binary snapshot
 * ciphertext by its byte length). A payload is one of:
 * - Legacy: `cipher` with `metadata.iv`
 * - Snapshot: a `snapshot`
 * - Tombstone: none needed
 */
export function validateItem(item: VaultItem) {
  // Calculate item length without expanding binary Buffers into huge JSON arrays
  let itemLength: number
  const cipher = item.snapshot?.cipher
  if (cipher instanceof Uint8Array) {
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

  const isTombstone = item.metadata.deleted === true
  const isLegacy = !!item.cipher
  const isSnapshot = !!item.snapshot

  const hasValidPayload = isTombstone
    || (isLegacy ? !!item.metadata.iv : isSnapshot)

  if (!hasValidPayload) {
    // Not the item itself: its ciphertext would end up in logs
    throw new Error(
      'Invalid item format: must be either legacy (cipher+iv) or snapshot.'
        + ` Item ${item.item} of account ${item.account}, length ${itemLength}`,
    )
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

/** The stored item with its binary snapshot ciphertext back in the base64 clients read */
export function fromStoredItem(record: VaultItem): FetchedVaultItem {
  const cipher = record.snapshot?.cipher
  if (!(cipher instanceof Uint8Array)) {
    return record
  }
  return { ...record, snapshot: { ...record.snapshot!, cipher: Buffer.from(cipher).toString('base64') } }
}

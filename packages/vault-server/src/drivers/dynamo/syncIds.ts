import type { ItemId } from '@vault/shared'

// Sync messages are keyed by `${account}#${itemId}`. Account IDs never contain '#', but item IDs may,
// so the item ID is everything after the first one.

export function toSyncId(account: string, itemId: string): string {
  return `${account}#${itemId}`
}

/** Splits a sync ID into its account and item ID, or returns undefined if it has no '#' */
export function parseSyncId(syncId: string): { account: string, itemId: ItemId } | undefined {
  const separator = syncId.indexOf('#')
  if (separator === -1) {
    return undefined
  }
  return {
    account: syncId.slice(0, separator),
    itemId: syncId.slice(separator + 1) as ItemId,
  }
}

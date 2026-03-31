import type { ItemId } from '../shared/itemTypes'

type CacheKey = ItemId | typeof METADATA_CACHE_KEY

const itemAutomergeBinaryCache = new Map<CacheKey, Uint8Array>()

const METADATA_CACHE_KEY = '__account_metadata__'

export function getCachedAutomergeBinary(itemId: ItemId): Uint8Array | undefined {
  return itemAutomergeBinaryCache.get(itemId)
}

export function setCachedAutomergeBinary(itemId: ItemId, binary: Uint8Array): void {
  itemAutomergeBinaryCache.set(itemId, binary)
}

export function clearCachedAutomergeBinary(itemId: ItemId): void {
  itemAutomergeBinaryCache.delete(itemId)
}

export function getCachedMetadataAutomergeBinary(): Uint8Array | undefined {
  return itemAutomergeBinaryCache.get(METADATA_CACHE_KEY)
}

export function setCachedMetadataAutomergeBinary(binary: Uint8Array): void {
  itemAutomergeBinaryCache.set(METADATA_CACHE_KEY, binary)
}

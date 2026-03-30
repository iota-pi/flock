const itemAutomergeBinaryCache = new Map<string, Uint8Array>()

const METADATA_CACHE_KEY = '__account_metadata__'

export function getCachedAutomergeBinary(itemId: string): Uint8Array | undefined {
  return itemAutomergeBinaryCache.get(itemId)
}

export function setCachedAutomergeBinary(itemId: string, binary: Uint8Array): void {
  itemAutomergeBinaryCache.set(itemId, binary)
}

export function clearCachedAutomergeBinary(itemId: string): void {
  itemAutomergeBinaryCache.delete(itemId)
}

export function getCachedMetadataAutomergeBinary(): Uint8Array | undefined {
  return itemAutomergeBinaryCache.get(METADATA_CACHE_KEY)
}

export function setCachedMetadataAutomergeBinary(binary: Uint8Array): void {
  itemAutomergeBinaryCache.set(METADATA_CACHE_KEY, binary)
}

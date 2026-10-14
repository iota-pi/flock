/**
 * Checks if a given error is a storage quota exceeded error.
 */
export function isQuotaError(err: unknown): boolean {
  if (!err) return false
  const name = (err as Error).name || ''
  const message = (err as Error).message || ''
  return (
    name === 'QuotaExceededError' ||
    name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    message.includes('QuotaExceededError') ||
    message.includes('quota exceeded')
  )
}

/**
 * Requests persistent storage status if not already granted.
 */
export async function ensurePersistentStorage(): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.storage && navigator.storage.persist) {
    // 1. Check if it's already persistent
    let isPersisted = await navigator.storage.persisted()

    // 2. Request persistence if not already granted
    if (!isPersisted) {
      isPersisted = await navigator.storage.persist()
    }

    return isPersisted
  }
  return false
}

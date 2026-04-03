let inMemoryLastSyncServerTime: number | null = null

function getStorageKey(accountId: string): string {
  return `lastSyncServerTime_${accountId}`
}

export function getLastSyncServerTime(accountId: string): number | null {
  if (typeof window === 'undefined' || !window.localStorage) {
    return inMemoryLastSyncServerTime
  }

  const rawValue = window.localStorage.getItem(getStorageKey(accountId))
  if (!rawValue) {
    return null
  }

  const parsed = Number(rawValue)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null
  }

  return parsed
}

export function setLastSyncServerTime(accountId: string, serverTime: number): void {
  inMemoryLastSyncServerTime = serverTime
  if (typeof window === 'undefined' || !window.localStorage) {
    return
  }

  window.localStorage.setItem(getStorageKey(accountId), serverTime.toString())
}

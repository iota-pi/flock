export function getOnlineState(): boolean {
  if (typeof navigator === 'undefined') return true
  return navigator.onLine
}

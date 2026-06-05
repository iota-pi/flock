export function getOnlineState(): boolean {
  if (typeof navigator === 'undefined') return true
  const isOnline = navigator.onLine
  const isVisible = typeof document === 'undefined' || document.visibilityState === 'visible'
  return isOnline && isVisible
}

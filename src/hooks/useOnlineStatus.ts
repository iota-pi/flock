import { useState } from 'react'
import { useEventListener } from 'usehooks-ts'

export function useOnlineStatus(): boolean {
  const [isOnline, setIsOnline] = useState<boolean>(() => (
    typeof navigator === 'undefined' ? true : navigator.onLine
  ))

  useEventListener('online', () => setIsOnline(true))
  useEventListener('offline', () => setIsOnline(false))

  return isOnline
}

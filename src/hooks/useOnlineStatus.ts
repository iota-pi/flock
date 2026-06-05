import { useState, useRef } from 'react'
import { useEventListener } from 'usehooks-ts'
import { getOnlineState } from 'src/utils/onlineStatus'

export function useOnlineStatus(): boolean {
  const [isOnline, setIsOnline] = useState<boolean>(getOnlineState)

  const handleStatusChange = () => {
    setIsOnline(getOnlineState())
  }

  const documentRef = useRef<Document | null>(typeof document !== 'undefined' ? document : null)

  useEventListener('online', handleStatusChange)
  useEventListener('offline', handleStatusChange)
  useEventListener('visibilitychange', handleStatusChange, documentRef as any)

  return isOnline
}

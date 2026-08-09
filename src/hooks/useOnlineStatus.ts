import { useState, useRef } from 'react'
import { useEventListener } from 'usehooks-ts'
import { getOnlineState } from 'src/utils/onlineStatus'

export function useOnlineStatus(): boolean {
  const [isOnline, setIsOnline] = useState<boolean>(getOnlineState)
  const documentRef = useRef<Document>(typeof document !== 'undefined' ? document : null!)

  const handleStatusChange = () => {
    setIsOnline(getOnlineState())
  }

  useEventListener('online', handleStatusChange)
  useEventListener('offline', handleStatusChange)
  useEventListener('visibilitychange', handleStatusChange, documentRef)

  return isOnline
}

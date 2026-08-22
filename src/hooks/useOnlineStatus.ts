import { useState } from 'react'
import { useEventListener } from 'usehooks-ts'
import { getOnlineState } from 'src/utils/onlineStatus'

export function useOnlineStatus(): boolean {
  const [isOnline, setIsOnline] = useState<boolean>(getOnlineState)

  const handleStatusChange = () => {
    setIsOnline(getOnlineState())
  }

  useEventListener('online', handleStatusChange)
  useEventListener('offline', handleStatusChange)

  return isOnline
}

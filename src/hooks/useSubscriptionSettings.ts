import { useCallback } from 'react'
import type { BaseToastMessage } from '../state/slices/toastSlice'
import { useAppStore } from '../state/store'
import { subscribe, unsubscribe } from '../utils/pushNotifications'

type SetMessage = (payload: BaseToastMessage) => void

type UseSubscriptionSettingsOptions = {
  setMessage: SetMessage
}

type UseSubscriptionSettingsResult = {
  actions: {
    handleSubscribe: (hours: number[] | null) => Promise<boolean>
  }
}

export default function useSubscriptionSettings({
  setMessage,
}: UseSubscriptionSettingsOptions): UseSubscriptionSettingsResult {
  const account = useAppStore(state => state.account)
  const handleSubscribe = useCallback(async (hours: number[] | null) => {
    try {
      if (hours) {
        await subscribe(account, hours)
        setMessage({ message: 'Notification saved' })
      } else {
        await unsubscribe(account)
        setMessage({ message: 'Notification removed' })
      }
      return true
    } catch (error) {
      setMessage({ message: 'Failed to update notification', severity: 'error' })
      console.error('Notification update failed', error)
      return false
    }
  }, [account, setMessage])

  return {
    actions: {
      handleSubscribe,
    },
  }
}
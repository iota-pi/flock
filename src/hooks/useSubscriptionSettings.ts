import { useCallback } from 'react'
import type { BaseToastMessage } from '../state/slices/toastSlice'
import { useAppStore } from '../state/store'

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
      const { subscribe, unsubscribe } = await import('../utils/pushNotifications')
      if (hours) {
        await subscribe(account, hours)
        setMessage({ message: 'Subscription saved' })
      } else {
        await unsubscribe(account)
        setMessage({ message: 'Subscription removed' })
      }
      return true
    } catch (error) {
      setMessage({ message: 'Failed to update subscription', severity: 'error' })
      console.error('Subscription update failed', error)
      return false
    }
  }, [account, setMessage])

  return {
    actions: {
      handleSubscribe,
    },
  }
}
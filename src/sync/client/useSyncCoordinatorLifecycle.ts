import { useEffect } from 'react'
import { useAppStore } from '../../state/store'
import { SyncBridge } from './SyncBridge'
import { resumePendingReencryption } from '../../api/vault/reencrypt'
import { fireAndForget } from '../utils/fireAndForget'

export default function useSyncCoordinatorLifecycle(
  account: string | null | undefined,
  enabled: boolean,
): void {
  useEffect(
    () => {
      const { clearFatalError } = useAppStore.getState()
      if (!enabled || !account) {
        if (!account) {
          clearFatalError()
        }
        return
      }

      clearFatalError()
      SyncBridge.initialize(account)
        .then(() => {
          fireAndForget(resumePendingReencryption(account), 'useSyncCoordinatorLifecycle:resumePendingReencryption')
        })
        .catch(error => {
          console.error('[useSyncCoordinatorLifecycle] bootstrap failed', error)
        })

      return () => {
        if (SyncBridge.isClearingLocalData?.()) {
          return
        }
        fireAndForget(
          SyncBridge.shutdown({ accountId: account }),
          'useSyncCoordinatorLifecycle:shutdown',
        )
      }
    },
    [account, enabled],
  )
}
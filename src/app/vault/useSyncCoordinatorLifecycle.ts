import { useEffect } from 'react'
import { useAppStore } from '../../state/store'
import { SyncBridge } from './syncBridge'
import { createLogger, fireAndForget, resumePendingReencryption } from '@vault/client'

const log = createLogger('useSyncCoordinatorLifecycle')

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
          fireAndForget(resumePendingReencryption(SyncBridge, account), 'useSyncCoordinatorLifecycle:resumePendingReencryption')
        })
        .catch(error => {
          log.error('bootstrap failed', error)
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
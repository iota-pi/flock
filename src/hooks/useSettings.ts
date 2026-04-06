import { useCallback, useMemo, useState } from 'react'
import { getNaturalPrayerGoal } from '../utils/prayer'
import {
  exportData,
  signOutVault,
} from '../api/vault'
import { useSetMetadataMutation, useStoreItemsMutation } from '../api/itemMutations'
import { useItems, useMetadata } from '../state/selectors'
import { getNextDarkMode } from '../themeUtils'
import type { Frequency } from '../utils/frequencies'
import type { Item } from '../state/items'
import { useUiStore } from '../state/uiStore'
import { useToastStore } from '../state/toastStore'
import { useSyncStore } from '../state/syncStore'
import { useAuth } from './useAuth'
import { AccountMetadata } from '../state/metadata'
import { queryClient } from '../api/queryClient'
import { getQueryKey } from '@trpc/react-query'
import { trpc } from '../api/trpc'
import {
  registerBackgroundSync,
} from '../sync/offlineQueue'
import {
  readDeadLetterQueue,
  readQueue,
  writeDeadLetterQueue,
  writeQueue,
} from '../sync/offlineQueueStore'
import type { BackupPayloadV1, RestorePayload } from '../types/backup'

export type SettingsDialogType = (
  | 'goal'
  | 'subscription'
  | 'restore'
  | 'offlineRecovery'
  | 'import'
  | 'defaultFrequency'
)

export default function useSettings() {
  const { account } = useAuth()
  const setMessage = useToastStore(state => state.setMessage)
  const setUi = useUiStore(state => state.setUi)
  const items = useItems()
  const storeItemsMutation = useStoreItemsMutation()
  const setMetadataMutation = useSetMetadataMutation()

  // Actions
  const handleSignOut = useCallback(
    async () => {
      await signOutVault()
      setMessage({ message: 'Signed out' })
    },
    [setMessage],
  )

  const darkMode = useUiStore(state => state.darkMode)
  const handleToggleDarkMode = useCallback(
    () => setUi({
      darkMode: (() => {
        const next = getNextDarkMode(darkMode)
        return next
      })()
    }),
    [darkMode, setUi],
  )

  const [cacheClearCounter, setCacheClearCounter] = useState(1)
  const handleClearCache = useCallback(
    () => {
      queryClient.clear()
      setCacheClearCounter(c => c + 1)
      setMessage({ message: 'Item cache cleared' })
    },
    [setMessage],
  )

  const handleExport = useCallback(
    async () => {
      try {
        const currentMetadata = queryClient.getQueryData<AccountMetadata>(getQueryKey(trpc.accounts.getMetadata)) || {}
        const backupPayload: BackupPayloadV1 = {
          version: 1,
          metadata: currentMetadata,
          items,
          offlineQueue: await readQueue(),
          deadLetterQueue: await readDeadLetterQueue(),
        }

        const data = await exportData(backupPayload)
        const json = JSON.stringify(data)
        setMessage({ message: 'Backup created' })
        return json
      } catch (err) {
        setMessage({ message: 'Failed to create backup', severity: 'error' })
        throw err
      }
    },
    [items, setMessage],
  )

  const handleConfirmRestore = useCallback(
    async ({
      deadLetterQueue,
      items: restoredItems,
      metadata,
      offlineQueue,
    }: Partial<RestorePayload> & Pick<RestorePayload, 'items'>) => {
      try {
        const parsedQueue = Array.isArray(offlineQueue) ? offlineQueue : []
        const parsedDlq = Array.isArray(deadLetterQueue) ? deadLetterQueue : []

        if (metadata) {
          await setMetadataMutation.mutateAsync(metadata)
        }

        await storeItemsMutation.mutateAsync(restoredItems)

        await writeQueue(parsedQueue)
        await writeDeadLetterQueue(parsedDlq)
        useSyncStore.getState().setOfflineQueueLength(parsedQueue.length)
        useSyncStore.getState().setDlqCount(parsedDlq.length)
        await registerBackgroundSync()

        setMessage({ message: 'Restore successful' })
        return true
      } catch (err) {
        setMessage({ message: 'Restore failed', severity: 'error' })
        console.error('Restore failed', err)
        return false
      }
    },
    [setMessage, setMetadataMutation, storeItemsMutation],
  )

  const handleConfirmImport = useCallback(
    async (imported: Item[]) => {
      try {
        await storeItemsMutation.mutateAsync(imported)
        setMessage({ message: 'Import successful' })
        return true
      } catch (err) {
        setMessage({ message: 'Import failed', severity: 'error' })
        console.error('Import failed', err)
        return false
      }
    },
    [setMessage, storeItemsMutation],
  )

  const handleSubscribe = useCallback(
    async (hours: number[] | null) => {
      try {
        const { subscribe, unsubscribe } = await import('../utils/pushNotifications')
        if (hours) {
          await subscribe(hours)
          setMessage({ message: 'Subscription saved' })
        } else {
          await unsubscribe()
          setMessage({ message: 'Subscription removed' })
        }
        return true
      } catch (err) {
        setMessage({ message: 'Failed to update subscription', severity: 'error' })
        console.error('Subscription update failed', err)
        return false
      }
    },
    [setMessage],
  )

  const [defaultFrequencies, setDefaultFrequencies] = useMetadata(
    'defaultPrayerFrequency',
    { person: 'none', group: 'none' },
  )

  const saveDefaultFrequencies = useCallback(async (d: Partial<Record<'person' | 'group', Frequency>>) => {
    try {
      await setDefaultFrequencies(prev => ({ ...(prev || {}), ...d }))
      setMessage({ message: 'Default prayer frequencies saved' })
    } catch (err) {
      setMessage({ message: 'Failed to save defaults', severity: 'error' })
      console.error('Failed to save default frequencies', err)
    }
  }, [setDefaultFrequencies, setMessage])

  // Values
  const naturalGoal = useMemo(() => getNaturalPrayerGoal(items), [items])
  const [goal] = useMetadata('prayerGoal', naturalGoal)

  const itemCacheExists = useMemo(
    () => (cacheClearCounter ? queryClient.getQueryData(getQueryKey(trpc.items.fetchMany)) !== undefined : false),
    [cacheClearCounter],
  )

  return {
    actions: {
      handleClearCache,
      handleConfirmImport,
      handleConfirmRestore,
      handleExport,
      handleSignOut,
      handleSubscribe,
      handleToggleDarkMode,
      saveDefaultFrequencies,
    },
    values: {
      account,
      darkMode,
      defaultFrequencies,
      goal,
      itemCacheExists,
      naturalGoal,
    },
  }
}

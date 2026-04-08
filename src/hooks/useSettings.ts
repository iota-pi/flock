import { useCallback, useMemo, useState } from 'react'
import { getNaturalPrayerGoal } from '../utils/prayer'
import {
  exportData,
  signOutVault,
} from '../api/vault'
import { mutateSetMetadata, mutateStoreItems } from '../features/items/mutations/itemMutations'
import { useItems, useMetadata } from '../state/selectors'
import { getNextDarkMode } from '../themeUtils'
import type { Frequency } from '../utils/frequencies'
import type { Item } from '../state/items'
import { useUiStore } from '../state/uiStore'
import { useToastStore } from '../state/toastStore'
import { useAuth } from './useAuth'
import { AccountMetadata } from '../state/metadata'
import { queryClient } from '../api/queryClient'
import { getQueryKey } from '@trpc/react-query'
import { trpc } from '../api/trpc'
import type { BackupPayloadV1, RestorePayload } from '../types/backup'
import { clearAutomergeDocStore, getAutomergeItems } from '../sync/automergeDocStore'
import { requestAutomergeSync } from '../sync/automergeSyncDispatcher'

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
    async () => {
      await clearAutomergeDocStore()
      queryClient.clear()
      requestAutomergeSync()
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
      items: restoredItems,
      metadata,
    }: Partial<RestorePayload> & Pick<RestorePayload, 'items'>) => {
      try {
        if (metadata) {
          await mutateSetMetadata(metadata)
        }

        await mutateStoreItems(restoredItems)

        setMessage({ message: 'Restore successful' })
        return true
      } catch (err) {
        setMessage({ message: 'Restore failed', severity: 'error' })
        console.error('Restore failed', err)
        return false
      }
    },
    [setMessage],
  )

  const handleConfirmImport = useCallback(
    async (imported: Item[]) => {
      try {
        await mutateStoreItems(imported)
        setMessage({ message: 'Import successful' })
        return true
      } catch (err) {
        setMessage({ message: 'Import failed', severity: 'error' })
        console.error('Import failed', err)
        return false
      }
    },
    [setMessage],
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
    () => (cacheClearCounter ? getAutomergeItems().length > 0 : false),
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

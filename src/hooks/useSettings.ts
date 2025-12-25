import { useCallback, useMemo, useState } from 'react'
import { useAppDispatch, useAppSelector } from '../store'
import { setMessage, setUi } from '../state/ui'
import { getNaturalPrayerGoal } from '../utils/prayer'
import {
  exportData,
  signOutVault,
  storeItems,
} from '../api/VaultLazy'
import { clearQueryCache, hasItemsInCache } from '../api/queries'
import { useItems, useMetadata } from '../state/selectors'
import { getNextDarkMode } from '../themeUtils'
import type { Frequency } from '../utils/frequencies'
import type { Item } from '../state/items'

export type SettingsDialogType = (
  | 'goal'
  | 'subscription'
  | 'restore'
  | 'import'
  | 'defaultFrequency'
)

export default function useSettings() {
  const account = useAppSelector(state => state.account.account)
  const dispatch = useAppDispatch()
  const items = useItems()

  // Actions
  const handleSignOut = useCallback(
    () => {
      signOutVault()
      dispatch(setMessage({ message: 'Signed out' }))
    },
    [dispatch],
  )

  const darkMode = useAppSelector(state => state.ui.darkMode)
  const handleToggleDarkMode = useCallback(
    () => dispatch(setUi({
      darkMode: (() => {
        const next = getNextDarkMode(darkMode)
        return next
      })()
    })),
    [darkMode, dispatch],
  )

  const [cacheClearCounter, setCacheClearCounter] = useState(1)
  const handleClearCache = useCallback(
    () => {
      clearQueryCache()
      setCacheClearCounter(c => c + 1)
      dispatch(setMessage({ message: 'Item cache cleared' }))
    },
    [],
  )

  const handleExport = useCallback(
    async () => {
      try {
        const data = await exportData(items)
        const json = JSON.stringify(data)
        dispatch(setMessage({ message: 'Backup created' }))
        return json
      } catch (err) {
        dispatch(setMessage({ message: 'Failed to create backup' }))
        throw err
      }
    },
    [items],
  )

  // Dialog State
  const [activeDialog, setActiveDialog] = useState<SettingsDialogType | null>(null)
  const openDialog = useCallback((type: SettingsDialogType) => setActiveDialog(type), [])
  const closeDialog = useCallback(() => setActiveDialog(null), [])

  // Dialog Actions
  const handleConfirmRestore = useCallback(
    async (restored: Item[]) => {
      try {
        await storeItems(restored)
        dispatch(setMessage({ message: 'Restore successful' }))
        closeDialog()
      } catch (err) {
        dispatch(setMessage({ message: 'Restore failed' }))
        console.error('Restore failed', err)
      }
    },
    [dispatch, closeDialog],
  )

  const handleConfirmImport = useCallback(
    async (imported: Item[]) => {
      try {
        await storeItems(imported)
        dispatch(setMessage({ message: 'Import successful' }))
        closeDialog()
      } catch (err) {
        dispatch(setMessage({ message: 'Import failed' }))
        console.error('Import failed', err)
      }
    },
    [dispatch, closeDialog],
  )

  const handleSubscribe = useCallback(
    async (hours: number[] | null) => {
      try {
        const { subscribe, unsubscribe } = await import('../utils/firebase')
        if (hours) {
          await subscribe(hours)
          dispatch(setMessage({ message: 'Subscription saved' }))
        } else {
          await unsubscribe()
          dispatch(setMessage({ message: 'Subscription removed' }))
        }
        closeDialog()
      } catch (err) {
        dispatch(setMessage({ message: 'Failed to update subscription' }))
        console.error('Subscription update failed', err)
      }
    },
    [closeDialog, dispatch],
  )

  const [defaultFrequencies, setDefaultFrequencies] = useMetadata(
    'defaultPrayerFrequency',
    { person: 'none', group: 'none' },
  )

  const saveDefaultFrequencies = useCallback(async (d: Partial<Record<'person' | 'group', Frequency>>) => {
    try {
      await setDefaultFrequencies(prev => ({ ...(prev || {}), ...d }))
      dispatch(setMessage({ message: 'Default prayer frequencies saved' }))
    } catch (err) {
      dispatch(setMessage({ message: 'Failed to save defaults' }))
      console.error('Failed to save default frequencies', err)
    }
  }, [dispatch, setDefaultFrequencies])

  // Values
  const naturalGoal = useMemo(() => getNaturalPrayerGoal(items), [items])
  const [goal] = useMetadata('prayerGoal', naturalGoal)

  const itemCacheExists = useMemo(
    () => (cacheClearCounter ? hasItemsInCache() : false),
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
    dialogs: {
      active: activeDialog,
      open: openDialog,
      close: closeDialog,
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

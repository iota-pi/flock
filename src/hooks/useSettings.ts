import { useCallback, useMemo, useState } from 'react'
import { useAppDispatch, useAppSelector } from '../store'
import { setMessage, setUi } from '../state/ui'
import { getNaturalPrayerGoal } from '../utils/prayer'
import {
  exportData,
  signOutVault,
  storeItems,
} from '../api/Vault'
import { clearQueryCache, hasItemsInCache } from '../api/queries'
import { useItems, useMetadata } from '../state/selectors'
import { subscribe, unsubscribe } from '../utils/firebase'
import { getNextDarkMode } from '../themeUtils'
import type { Frequency } from '../utils/frequencies'
import type { Item } from '../state/items'

export default function useSettings() {
  const account = useAppSelector(state => state.account.account)
  const dispatch = useAppDispatch()
  const items = useItems()

  const handleSignOut = useCallback(
    () => {
      signOutVault()
      dispatch(setMessage({ message: 'Signed out' }))
    },
    [dispatch],
  )

  const darkMode = useAppSelector(state => state.ui.darkMode)
  const handleToggleDarkMode = useCallback(
    () => dispatch(setUi({ darkMode: (() => {
      const next = getNextDarkMode(darkMode)
      return next
    })() })),
    [darkMode, dispatch],
  )

  const naturalGoal = useMemo(() => getNaturalPrayerGoal(items), [items])
  const [goal] = useMetadata('prayerGoal', naturalGoal)
  const [defaultFrequencies, setDefaultFrequencies] = useMetadata(
    'defaultPrayerFrequency',
    { person: 'none', group: 'none' },
  )

  const [cacheClearCounter, setCacheClearCounter] = useState(1)
  const itemCacheExists = useMemo(
    () => (cacheClearCounter ? hasItemsInCache() : false),
    [cacheClearCounter],
  )
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
  // Dialog state
  const [showGoalDialog, setShowGoalDialog] = useState(false)
  const [showSubscriptionDialog, setShowSubscriptionDialog] = useState(false)
  const [showRestoreDialog, setShowRestoreDialog] = useState(false)
  const [showImportDialog, setShowImportDialog] = useState(false)

  const openGoalDialog = useCallback(() => setShowGoalDialog(true), [])
  const closeGoalDialog = useCallback(() => setShowGoalDialog(false), [])

  const openSubscriptionDialog = useCallback(() => setShowSubscriptionDialog(true), [])
  const closeSubscriptionDialog = useCallback(() => setShowSubscriptionDialog(false), [])

  const openRestoreDialog = useCallback(() => setShowRestoreDialog(true), [])
  const closeRestoreDialog = useCallback(() => setShowRestoreDialog(false), [])

  const openImportDialog = useCallback(() => setShowImportDialog(true), [])
  const closeImportDialog = useCallback(() => setShowImportDialog(false), [])

  const handleConfirmRestore = useCallback(
    async (restored: Item[]) => {
      try {
        await storeItems(restored)
        dispatch(setMessage({ message: 'Restore successful' }))
        closeRestoreDialog()
      } catch (err) {
        dispatch(setMessage({ message: 'Restore failed' }))
        console.error('Restore failed', err)
      }
    },
    [dispatch, closeRestoreDialog],
  )

  const handleConfirmImport = useCallback(
    async (imported: Item[]) => {
      try {
        await storeItems(imported)
        dispatch(setMessage({ message: 'Import successful' }))
        closeImportDialog()
      } catch (err) {
        dispatch(setMessage({ message: 'Import failed' }))
        console.error('Import failed', err)
      }
    },
    [dispatch, closeImportDialog],
  )

  const handleSubscribe = useCallback(
    async (hours: number[] | null) => {
      try {
        if (hours) {
          await subscribe(hours)
          dispatch(setMessage({ message: 'Subscription saved' }))
        } else {
          await unsubscribe()
          dispatch(setMessage({ message: 'Subscription removed' }))
        }
        closeSubscriptionDialog()
      } catch (err) {
        dispatch(setMessage({ message: 'Failed to update subscription' }))
        console.error('Subscription update failed', err)
      }
    },
    [closeSubscriptionDialog],
  )

  // Default frequency dialog
  const [showDefaultFrequencyDialog, setShowDefaultFrequencyDialog] = useState(false)
  const openDefaultFrequencyDialog = useCallback(() => setShowDefaultFrequencyDialog(true), [])
  const closeDefaultFrequencyDialog = useCallback(() => setShowDefaultFrequencyDialog(false), [])

  const saveDefaultFrequencies = useCallback(async (d: Partial<Record<'person'|'group', Frequency>>) => {
    try {
      await setDefaultFrequencies(prev => ({ ...(prev || {}), ...d }))
      dispatch(setMessage({ message: 'Default prayer frequencies saved' }))
    } catch (err) {
      dispatch(setMessage({ message: 'Failed to save defaults' }))
      console.error('Failed to save default frequencies', err)
    }
  }, [dispatch, setDefaultFrequencies])

  return {
    account,
    darkMode,
    handleSignOut,
    handleToggleDarkMode,
    naturalGoal,
    goal,
    itemCacheExists,
    handleClearCache,
    handleExport,
    showGoalDialog,
    openGoalDialog,
    closeGoalDialog,
    showSubscriptionDialog,
    openSubscriptionDialog,
    closeSubscriptionDialog,
    showRestoreDialog,
    openRestoreDialog,
    closeRestoreDialog,
    showImportDialog,
    openImportDialog,
    closeImportDialog,
    handleConfirmRestore,
    handleConfirmImport,
    handleSubscribe,
    showDefaultFrequencyDialog,
    openDefaultFrequencyDialog,
    closeDefaultFrequencyDialog,
    defaultFrequencies,
    saveDefaultFrequencies,
  }
}

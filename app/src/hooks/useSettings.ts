import { useCallback, useMemo, useState } from 'react'
import { useAppDispatch, useAppSelector } from '../store'
import { setMessage, setUi } from '../state/ui'
import { getNaturalPrayerGoal } from '../utils/prayer'
import { checkItemCache, clearItemCache, exportData, storeItems, signOutVault } from '../api/Vault'
import { useItems, useMetadata } from '../state/selectors'
import { subscribe, unsubscribe } from '../utils/firebase'
import { getNextDarkMode } from '../themeUtils'
import { setMetadata } from '../api/Vault'
import { Frequency } from '../utils/frequencies'

export default function useSettings() {
  const account = useAppSelector(state => state.account.account)
  const dispatch = useAppDispatch()
  const items = useItems()

  const handleSignOut = useCallback(
    () => signOutVault(),
    [],
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

  const metadata = useAppSelector(state => state.account.metadata)
  const defaultFrequencies: Partial<Record<'person'|'group', Frequency>> = metadata?.defaultPrayerFrequency ?? { person: 'none', group: 'none' }

  const [cacheClearCounter, setCacheClearCounter] = useState(1)
  const itemCacheExists = useMemo(
    () => (cacheClearCounter ? checkItemCache() : false),
    [cacheClearCounter],
  )
  const handleClearCache = useCallback(
    () => {
      clearItemCache()
      setCacheClearCounter(c => c + 1)
    },
    [],
  )

  const handleExport = useCallback(
    async () => {
      const data = await exportData(items)
      const json = JSON.stringify(data)
      return json
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
    async (restored: any[]) => {
      await storeItems(restored)
      dispatch(setMessage({ message: 'Restore successful' }))
      closeRestoreDialog()
    },
    [dispatch, closeRestoreDialog],
  )

  const handleConfirmImport = useCallback(
    async (imported: any[]) => {
      await storeItems(imported)
      dispatch(setMessage({ message: 'Import successful' }))
      closeImportDialog()
    },
    [dispatch, closeImportDialog],
  )

  const handleSubscribe = useCallback(
    async (hours: number[] | null) => {
      if (hours) {
        await subscribe(hours)
      } else {
        await unsubscribe()
      }
      closeSubscriptionDialog()
    },
    [closeSubscriptionDialog],
  )

  // Default frequency dialog
  const [showDefaultFrequencyDialog, setShowDefaultFrequencyDialog] = useState(false)
  const openDefaultFrequencyDialog = useCallback(() => setShowDefaultFrequencyDialog(true), [])
  const closeDefaultFrequencyDialog = useCallback(() => setShowDefaultFrequencyDialog(false), [])

  const saveDefaultFrequencies = useCallback(async (d: Partial<Record<'person'|'group', Frequency>>) => {
    const newMetadata = { ...metadata, defaultPrayerFrequency: { ...(metadata?.defaultPrayerFrequency || {}), ...d } }
    try {
      await setMetadata(newMetadata)
      dispatch(setMessage({ message: 'Defaults saved' }))
    } catch (err) {
      dispatch(setMessage({ message: 'Failed to save defaults' }))
    }
  }, [metadata, dispatch])

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

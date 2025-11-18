import { useCallback, useMemo, useState } from 'react'
import { useAppDispatch, useAppSelector } from '../store'
import { setMessage, setUi } from '../state/ui'
import { getNaturalPrayerGoal } from '../utils/prayer'
import { checkItemCache, clearItemCache, exportData, storeItems, signOutVault } from '../api/Vault'
import { useItems, useMetadata } from '../state/selectors'

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

  const handleConfirmRestore = useCallback(
    async (restored: any[]) => {
      await storeItems(restored)
      dispatch(setMessage({ message: 'Restore successful' }))
    },
    [dispatch],
  )

  const handleConfirmImport = useCallback(
    async (imported: any[]) => {
      await storeItems(imported)
      dispatch(setMessage({ message: 'Import successful' }))
    },
    [dispatch],
  )

  const handleSubscribe = useCallback(
    async (fn: (hours: number[] | null) => Promise<void>, hours: number[] | null) => {
      await fn(hours)
    },
    [],
  )

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
    handleConfirmRestore,
    handleConfirmImport,
    handleSubscribe,
  }
}

// helper to pick next dark mode; kept local to avoid importing theme directly here
function getNextDarkMode(current: boolean | null) {
  if (current === null) return true
  return !current
}

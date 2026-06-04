import { useCallback, useMemo } from 'react'
import { getNaturalPrayerGoal } from '../utils/prayer'
import {
  signOutVault,
} from '../api/vault'
import { useMetadata } from '../state/selectors'
import type { Frequency } from '../utils/frequencies'
import { useToastStore } from '../state/toastStore'
import { useAuth } from './useAuth'
import useBackupAndRestore from './useBackupAndRestore'
import useThemeSettings from './useThemeSettings'
import useSubscriptionSettings from './useSubscriptionSettings'
import type { Item } from '../state/items'
import { useDataRecovery } from './useDataRecovery'

export default function useSettings(items: Item[]) {
  const { account } = useAuth()
  const setMessage = useToastStore(state => state.setMessage)

  const {
    actions: backupActions,
  } = useBackupAndRestore({ setMessage })
  const {
    actions: themeActions,
    values: themeValues,
  } = useThemeSettings()
  const {
    actions: subscriptionActions,
  } = useSubscriptionSettings({ setMessage })

  const { recoveryItems } = useDataRecovery()
  const recoveryItemsExist = recoveryItems.length > 0

  // Actions
  const handleSignOut = useCallback(
    async () => {
      await signOutVault()
      setMessage({ message: 'Signed out' })
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

  return {
    actions: {
      handleConfirmImport: backupActions.handleConfirmImport,
      handleConfirmRestore: backupActions.handleConfirmRestore,
      handleExport: backupActions.handleExport,
      handleSignOut,
      handleSubscribe: subscriptionActions.handleSubscribe,
      handleToggleDarkMode: themeActions.handleToggleDarkMode,
      saveDefaultFrequencies,
    },
    values: {
      account,
      darkMode: themeValues.darkMode,
      defaultFrequencies,
      goal,
      recoveryItemsExist,
      naturalGoal,
    },
  }
}

import { useCallback, useEffect, useMemo, useState } from 'react'

import { getNaturalPrayerGoal } from '../utils/prayer'
import {
  lockVault,
  removeVaultFromDevice,
  enableBiometrics,
  disableBiometrics,
  hasBiometricData,
  isWebAuthnPrfSupported,
} from '../api/vault'
import { useMetadata } from '../state/selectors'
import { useAppStore } from '../state/store'
import type { Frequency } from '../utils/frequencies'
import useBackupAndRestore from './useBackupAndRestore'
import useThemeSettings from './useThemeSettings'
import useSubscriptionSettings from './useSubscriptionSettings'
import type { Item } from '../state/items'
import { useDataRecovery } from './useDataRecovery'

import {
  readAutoLockSettings,
  writeAutoLockSettings,
  getAutoLockSummary,
  type AutoLockSettings,
} from '../api/vault/autoLockStore'

export default function useSettings(items: Item[]) {
  const account = useAppStore(state => state.account)
  const setMessage = useAppStore(state => state.setMessage)

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

  const [biometricsSupported, setBiometricsSupported] = useState(false)
  const [biometricsEnabled, setBiometricsEnabled] = useState(() => hasBiometricData())
  const [autoLockSettings, setAutoLockSettings] = useState(() => readAutoLockSettings())

  useEffect(() => {
    void isWebAuthnPrfSupported().then(setBiometricsSupported)
  }, [])

  const handleToggleBiometrics = useCallback(async () => {
    if (biometricsEnabled) {
      disableBiometrics()
      setBiometricsEnabled(false)
      setMessage({ message: 'Biometric unlock disabled' })
    } else {
      try {
        await enableBiometrics(account)
        setBiometricsEnabled(true)
        setMessage({ severity: 'success', message: 'Biometric unlock enabled' })
      } catch (err) {
        console.error('[useSettings] enableBiometrics failed', err)
        const msg = err instanceof Error ? err.message : 'Failed to enable biometrics'
        setMessage({ severity: 'error', message: msg })
      }
    }
  }, [account, biometricsEnabled, setMessage])

  const saveAutoLockSettings = useCallback((settings: AutoLockSettings) => {
    writeAutoLockSettings(settings)
    setAutoLockSettings(settings)
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('flock-autolock-changed'))
    }
    setMessage({ message: 'Auto-lock settings saved' })
  }, [setMessage])

  // Actions
  const handleLock = useCallback(
    async () => {
      await lockVault()
      setMessage({ message: 'App locked' })
    },
    [setMessage],
  )

  const handleRemoveAccountFromDevice = useCallback(
    async () => {
      await removeVaultFromDevice()
      setMessage({ message: 'Signed out and removed local data' })
    },
    [setMessage],
  )

  const [defaultFrequencies, setDefaultFrequencies] = useMetadata(
    'defaultPrayerFrequency',
    { person: 'none', group: 'none', topic: 'none' },
  )

  const saveDefaultFrequencies = useCallback(async (d: Partial<Record<'person' | 'group' | 'topic', Frequency>>) => {
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
      handleLock,
      handleRemoveAccountFromDevice,
      handleSignOut: handleRemoveAccountFromDevice,
      handleSubscribe: subscriptionActions.handleSubscribe,
      handleToggleDarkMode: themeActions.handleToggleDarkMode,
      handleToggleBiometrics,
      saveAutoLockSettings,
      saveDefaultFrequencies,
    },
    values: {
      account,
      darkMode: themeValues.darkMode,
      defaultFrequencies,
      goal,
      recoveryItemsExist,
      naturalGoal,
      biometricsEnabled,
      biometricsSupported,
      autoLockSummary: getAutoLockSummary(autoLockSettings),
    },
  }
}

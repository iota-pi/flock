import { useCallback } from 'react'
import {
  Divider,
  Typography,
} from '@mui/material'
import download from 'js-file-download'
import BasePage from './BasePage'
import type { Item } from '../../state/items'
import useSettings from '../../hooks/useSettings'
import { useDialogState } from '../../hooks/useDialogState'
import PageContainer from '../ui/PageContainer'
import type { RestorePayload } from '../../types/backup'
import SettingsItemsList from './settings/SettingsItemsList'
import SettingsDialogs from './settings/SettingsDialogs'
import type { SettingsActionId } from './settings/settingsConfig'

function SettingsPage() {
  const { actions, values } = useSettings()
  const goalDialog = useDialogState('goal')
  const restoreDialog = useDialogState('restore')
  const offlineRecoveryDialog = useDialogState('offlineRecovery')
  const importDialog = useDialogState('import')
  const subscriptionDialog = useDialogState('subscription')
  const defaultFrequencyDialog = useDialogState('defaultFrequency')

  const onExport = useCallback(
    async () => {
      try {
        const json = await actions.handleExport()
        download(json, 'flock.backup.json')
      } catch (err) {
        console.error('Export failed', err)
      }
    },
    [actions],
  )

  const actionHandlers: Record<SettingsActionId, () => void> = {
    signOut: () => {
      void actions.handleSignOut()
    },
    clearCache: () => {
      void actions.handleClearCache()
    },
    toggleDarkMode: actions.handleToggleDarkMode,
    openGoalDialog: goalDialog.openDialog,
    openDefaultFrequencyDialog: defaultFrequencyDialog.openDialog,
    openSubscriptionDialog: subscriptionDialog.openDialog,
    exportData: () => {
      void onExport()
    },
    openRestoreDialog: restoreDialog.openDialog,
    openOfflineRecoveryDialog: offlineRecoveryDialog.openDialog,
    openImportDialog: importDialog.openDialog,
  }

  const handleRestoreConfirm = useCallback(async (payload: RestorePayload) => {
    const saved = await actions.handleConfirmRestore(payload)
    if (saved) {
      restoreDialog.closeDialog()
    }
  }, [actions, restoreDialog])

  const handleImportConfirm = useCallback(async (items: Item[]) => {
    const saved = await actions.handleConfirmImport(items)
    if (saved) {
      importDialog.closeDialog()
    }
  }, [actions, importDialog])

  const handleSubscriptionSave = useCallback(async (hours: Parameters<typeof actions.handleSubscribe>[0]) => {
    const saved = await actions.handleSubscribe(hours)
    if (saved) {
      subscriptionDialog.closeDialog()
    }
  }, [actions, subscriptionDialog])

  return (
    <BasePage>
      <PageContainer maxWidth="xl">
        <Typography variant="h4" fontWeight={300} gutterBottom>
          Settings
        </Typography>

        <Typography color="textSecondary">
          Account ID: {values.account}
        </Typography>
      </PageContainer>

      <Divider />

      <SettingsItemsList actionHandlers={actionHandlers} values={values} />

      <SettingsDialogs
        defaultFrequencies={values.defaultFrequencies}
        dialogs={{
          defaultFrequency: defaultFrequencyDialog,
          goal: goalDialog,
          import: importDialog,
          offlineRecovery: offlineRecoveryDialog,
          restore: restoreDialog,
          subscription: subscriptionDialog,
        }}
        handlers={{
          onImportConfirm: handleImportConfirm,
          onRestoreConfirm: handleRestoreConfirm,
          onSaveDefaultFrequencies: actions.saveDefaultFrequencies,
          onSubscriptionSave: handleSubscriptionSave,
        }}
        naturalGoal={values.naturalGoal}
      />
    </BasePage>
  )
}

export default SettingsPage

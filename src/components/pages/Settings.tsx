import { useCallback } from 'react'
import {
  Box,
  Divider,
  Typography,
} from '@mui/material'
import download from 'js-file-download'
import BasePage from './BasePage'
import type { Item } from '../../state/items'
import useSettings from '../../hooks/useSettings'
import { useDialogState } from '../../hooks/useDialogState'
import type { RestorePayload } from '../../types/backup'
import SettingsItemsList from './settings/SettingsItemsList'
import SettingsDialogs from './settings/SettingsDialogs'
import type { SettingsActionId } from './settings/settingsConfig'
import { useVisibleItems } from 'src/state/selectors'

function SettingsPage() {
  const items = useVisibleItems()
  const existingPeople = items.filter(item => item.type === 'person')
  const { actions, values } = useSettings(items)
  const goalDialog = useDialogState('goal')
  const restoreDialog = useDialogState('restore')
  const recoveryDialog = useDialogState('dataRecovery')
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
    openRecoveryDialog: recoveryDialog.openDialog,
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
      <Box sx={{
        padding: 2
      }}>
        <Typography variant="h4" gutterBottom sx={{
          fontWeight: 300
        }}>
          Settings
        </Typography>

        <Typography color="textSecondary">
          Account ID: {values.account}
        </Typography>
      </Box>
      <Divider />
      <SettingsItemsList actionHandlers={actionHandlers} values={values} />
      <SettingsDialogs
        defaultFrequencies={values.defaultFrequencies}
        dialogs={{
          defaultFrequency: defaultFrequencyDialog,
          goal: goalDialog,
          import: importDialog,
          dataRecovery: recoveryDialog,
          restore: restoreDialog,
          subscription: subscriptionDialog,
        }}
        existingPeople={existingPeople}
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

import { useCallback, useState } from 'react'
import download from 'js-file-download'
import Box from '@mui/material/Box'
import Divider from '@mui/material/Divider'
import Typography from '@mui/material/Typography'

import BasePage from './BasePage'
import type { Item } from 'src/state/items'
import useSettings from 'src/hooks/useSettings'
import { useDialogState } from 'src/hooks/useDialogState'
import type { BackupPayloadV2 } from 'src/types/backup'
import SettingsItemsList from './settings/SettingsItemsList'
import SettingsDialogs from './settings/SettingsDialogs'
import type { SettingsActionId } from './settings/settingsConfig'
import { useVisibleItems } from 'src/state/selectors'
import ConfirmationDialog from '../dialogs/ConfirmationDialog'


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
  const changePasswordDialog = useDialogState('changePassword')
  const reencryptDialog = useDialogState('reencrypt')
  const [confirmRemoveAccountOpen, setConfirmRemoveAccountOpen] = useState(false)

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

  const handleConfirmRemoveAccount = useCallback(() => {
    setConfirmRemoveAccountOpen(false)
    void actions.handleRemoveAccountFromDevice()
  }, [actions])

  const actionHandlers: Record<SettingsActionId, () => void> = {
    lock: () => {
      void actions.handleLock()
    },
    removeAccount: () => {
      setConfirmRemoveAccountOpen(true)
    },
    toggleDarkMode: actions.handleToggleDarkMode,
    openGoalDialog: goalDialog.openDialog,
    openDefaultFrequencyDialog: defaultFrequencyDialog.openDialog,
    openSubscriptionDialog: subscriptionDialog.openDialog,
    openChangePasswordDialog: changePasswordDialog.openDialog,
    exportData: () => {
      void onExport()
    },
    openRestoreDialog: restoreDialog.openDialog,
    openRecoveryDialog: recoveryDialog.openDialog,
    openImportDialog: importDialog.openDialog,
  }

  const handleRestoreConfirm = useCallback(async (payload: BackupPayloadV2) => {
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
          changePassword: changePasswordDialog,
          reencrypt: reencryptDialog,
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
      <ConfirmationDialog
        cancel="Cancel"
        confirm="Sign out & remove data"
        confirmColour="error"
        onCancel={() => setConfirmRemoveAccountOpen(false)}
        onConfirm={handleConfirmRemoveAccount}
        open={confirmRemoveAccountOpen}
        title="Sign out and remove local data?"
      >
        <Typography component="p" gutterBottom>
          Are you sure you want to sign out and remove all local data from this device?
          You will need an active internet connection
          to download your data again the next time you sign in.
        </Typography>
        <Typography>
          It is <strong>highly recommended</strong> to perform this action on shared devices
          or in high-security environments.
          Otherwise, you could simply lock the app.
        </Typography>
      </ConfirmationDialog>
    </BasePage>
  )
}

export default SettingsPage

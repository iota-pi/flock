import { Suspense } from 'react'
import { lazy } from 'src/utils/lazy'
import type { Frequency } from 'src/utils/frequencies'
import type { Item } from 'src/state/items'
import type { BackupPayloadV2 } from 'src/types/backup'
import type { AutoLockSettings } from '@vault/client'

const GoalDialog = lazy(() => import('../../dialogs/GoalDialog'))
const RestoreBackupDialog = lazy(() => import('../../dialogs/RestoreBackupDialog'))
const DataRecoveryDialog = lazy(() => import('../../dialogs/DataRecoveryDialog'))
const ImportPeopleDialog = lazy(() => import('../../dialogs/ImportPeopleDialog'))
const SubscriptionDialog = lazy(() => import('../../dialogs/SubscriptionDialog'))
const DefaultFrequencyDialog = lazy(() => import('../../dialogs/DefaultFrequencyDialog'))
const ChangePasswordDialog = lazy(() => import('../../dialogs/ChangePasswordDialog'))
const ReencryptVaultDialog = lazy(() => import('../../dialogs/ReencryptVaultDialog'))
const AutoLockDialog = lazy(() => import('../../dialogs/AutoLockDialog'))


type DialogState = {
  isOpen: boolean
  openDialog: () => void
  closeDialog: () => void
}

type SettingsDialogsProps = {
  existingPeople: Item[]
  defaultFrequencies: Partial<Record<'person' | 'group' | 'topic', Frequency>>
  dialogs: {
    autoLock: DialogState
    defaultFrequency: DialogState
    goal: DialogState
    import: DialogState
    dataRecovery: DialogState
    restore: DialogState
    subscription: DialogState
    changePassword: DialogState
    reencrypt: DialogState
  }
  handlers: {
    onImportConfirm: (items: Item[]) => Promise<void>
    onRestoreConfirm: (payload: BackupPayloadV2) => Promise<void>
    onSaveAutoLockSettings: (settings: AutoLockSettings) => void
    onSaveDefaultFrequencies: (defaults: Partial<Record<'person' | 'group' | 'topic', Frequency>>) => Promise<void>
    onSubscriptionSave: (hours: number[] | null) => Promise<void>
  }
  naturalGoal: number
}

export default function SettingsDialogs({
  existingPeople,
  defaultFrequencies,
  dialogs,
  handlers,
  naturalGoal,
}: SettingsDialogsProps) {
  // One boundary per dialog. Under a shared boundary React requests each lazy chunk only after the
  // previous one resolves, and no dialog can open until every chunk has loaded.
  return (
    <>
      <Suspense fallback={null}>
        <GoalDialog
          naturalGoal={naturalGoal}
          onClose={dialogs.goal.closeDialog}
          open={dialogs.goal.isOpen}
        />
      </Suspense>
      <Suspense fallback={null}>
        <RestoreBackupDialog
          onClose={dialogs.restore.closeDialog}
          onConfirm={handlers.onRestoreConfirm}
          open={dialogs.restore.isOpen}
        />
      </Suspense>
      <Suspense fallback={null}>
        <DataRecoveryDialog
          onClose={dialogs.dataRecovery.closeDialog}
          open={dialogs.dataRecovery.isOpen}
        />
      </Suspense>
      <Suspense fallback={null}>
        <ImportPeopleDialog
          existingPeople={existingPeople}
          onClose={dialogs.import.closeDialog}
          onConfirm={handlers.onImportConfirm}
          open={dialogs.import.isOpen}
        />
      </Suspense>
      <Suspense fallback={null}>
        <SubscriptionDialog
          onClose={dialogs.subscription.closeDialog}
          onSave={handlers.onSubscriptionSave}
          open={dialogs.subscription.isOpen}
        />
      </Suspense>
      <Suspense fallback={null}>
        <DefaultFrequencyDialog
          open={dialogs.defaultFrequency.isOpen}
          defaults={defaultFrequencies}
          onClose={dialogs.defaultFrequency.closeDialog}
          onSave={handlers.onSaveDefaultFrequencies}
        />
      </Suspense>
      <Suspense fallback={null}>
        <ChangePasswordDialog
          open={dialogs.changePassword.isOpen}
          onClose={dialogs.changePassword.closeDialog}
          onPasswordChanged={dialogs.reencrypt.openDialog}
        />
      </Suspense>
      <Suspense fallback={null}>
        <ReencryptVaultDialog
          open={dialogs.reencrypt.isOpen}
          onClose={dialogs.reencrypt.closeDialog}
        />
      </Suspense>
      <Suspense fallback={null}>
        <AutoLockDialog
          open={dialogs.autoLock.isOpen}
          onClose={dialogs.autoLock.closeDialog}
          onSave={handlers.onSaveAutoLockSettings}
        />
      </Suspense>
    </>
  )
}
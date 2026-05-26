import { Suspense, lazy } from 'react'
import type { Frequency } from 'src/utils/frequencies'
import type { Item } from 'src/state/items'
import type { RestorePayload } from 'src/types/backup'

const GoalDialog = lazy(() => import('../../dialogs/GoalDialog'))
const RestoreBackupDialog = lazy(() => import('../../dialogs/RestoreBackupDialog'))
const DataRecoveryDialog = lazy(() => import('../../dialogs/DataRecoveryDialog'))
const ImportPeopleDialog = lazy(() => import('../../dialogs/ImportPeopleDialog'))
const SubscriptionDialog = lazy(() => import('../../dialogs/SubscriptionDialog'))
const DefaultFrequencyDialog = lazy(() => import('../../dialogs/DefaultFrequencyDialog'))

type DialogState = {
  isOpen: boolean
  closeDialog: () => void
}

type SettingsDialogsProps = {
  existingPeople: Item[]
  defaultFrequencies: Partial<Record<'person' | 'group', Frequency>>
  dialogs: {
    defaultFrequency: DialogState
    goal: DialogState
    import: DialogState
    dataRecovery: DialogState
    restore: DialogState
    subscription: DialogState
  }
  handlers: {
    onImportConfirm: (items: Item[]) => Promise<void>
    onRestoreConfirm: (payload: RestorePayload) => Promise<void>
    onSaveDefaultFrequencies: (defaults: Partial<Record<'person' | 'group', Frequency>>) => Promise<void>
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
  return (
    <Suspense fallback={null}>
      <GoalDialog
        naturalGoal={naturalGoal}
        onClose={dialogs.goal.closeDialog}
        open={dialogs.goal.isOpen}
      />
      <RestoreBackupDialog
        onClose={dialogs.restore.closeDialog}
        onConfirm={handlers.onRestoreConfirm}
        open={dialogs.restore.isOpen}
      />
      <DataRecoveryDialog
        onClose={dialogs.dataRecovery.closeDialog}
        open={dialogs.dataRecovery.isOpen}
      />
      <ImportPeopleDialog
        existingPeople={existingPeople}
        onClose={dialogs.import.closeDialog}
        onConfirm={handlers.onImportConfirm}
        open={dialogs.import.isOpen}
      />
      <SubscriptionDialog
        onClose={dialogs.subscription.closeDialog}
        onSave={handlers.onSubscriptionSave}
        open={dialogs.subscription.isOpen}
      />
      <DefaultFrequencyDialog
        open={dialogs.defaultFrequency.isOpen}
        defaults={defaultFrequencies}
        onClose={dialogs.defaultFrequency.closeDialog}
        onSave={handlers.onSaveDefaultFrequencies}
      />
    </Suspense>
  )
}
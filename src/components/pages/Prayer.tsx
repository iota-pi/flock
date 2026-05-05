import PrayerPageContent from './prayer/PrayerPageContent'
import usePrayerFlow from './prayer/usePrayerFlow'
import { useDialogState } from '../../hooks/useDialogState'


function PrayerPage() {
  const flow = usePrayerFlow()
  const {
    closeDialog: closeGoalDialog,
    isOpen: isGoalDialogOpen,
    openDialog: openGoalDialog,
  } = useDialogState('goal')

  return (
    <PrayerPageContent
      flow={flow}
      isGoalDialogOpen={isGoalDialogOpen}
      onCloseGoalDialog={closeGoalDialog}
      onEditGoal={openGoalDialog}
    />
  )
}

export default PrayerPage

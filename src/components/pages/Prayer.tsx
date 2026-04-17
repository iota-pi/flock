import { useCallback, useState } from 'react'
import PrayerPageContent from './prayer/PrayerPageContent'
import usePrayerFlow from './prayer/usePrayerFlow'
import { useDialogState } from '../../hooks/useDialogState'


function PrayerPage() {
  const flow = usePrayerFlow()
  const currentFlow = flow.view.current
  const [activeEditDrawerKey, setActiveEditDrawerKey] = useState<string | null>(null)
  const {
    closeDialog: closeGoalDialog,
    isOpen: isGoalDialogOpen,
    openDialog: openGoalDialog,
  } = useDialogState('goal')

  const currentActiveDrawerKey = currentFlow.type === 'active' ? String(currentFlow.index) : null
  const isEditDrawerOpen = currentActiveDrawerKey !== null && activeEditDrawerKey === currentActiveDrawerKey

  const handleOpenEditDrawer = useCallback(() => {
    if (currentFlow.type === 'active') {
      setActiveEditDrawerKey(String(currentFlow.index))
    }
  }, [currentFlow])

  const handleCloseEditDrawer = useCallback(
    () => {
      flow.actions.handleCloseEditDrawer()
      setActiveEditDrawerKey(null)
    },
    [flow.actions],
  )

  return (
    <PrayerPageContent
      flow={flow}
      isEditDrawerOpen={isEditDrawerOpen}
      isGoalDialogOpen={isGoalDialogOpen}
      onCloseEditDrawer={handleCloseEditDrawer}
      onCloseGoalDialog={closeGoalDialog}
      onEditGoal={openGoalDialog}
      onOpenEditDrawer={handleOpenEditDrawer}
    />
  )
}

export default PrayerPage

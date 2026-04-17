import { useCallback, useState } from 'react'
import PrayerPageContent from './prayer/PrayerPageContent'
import usePrayerFlow from './prayer/usePrayerFlow'
import { useDialogState } from '../../hooks/useDialogState'


function PrayerPage() {
  const flow = usePrayerFlow()
  const [activeEditDrawerKey, setActiveEditDrawerKey] = useState<string | null>(null)
  const {
    closeDialog: closeGoalDialog,
    isOpen: isGoalDialogOpen,
    openDialog: openGoalDialog,
  } = useDialogState('goal')

  const currentActiveDrawerKey = flow.flow.type === 'active' ? String(flow.flow.index) : null
  const isEditDrawerOpen = currentActiveDrawerKey !== null && activeEditDrawerKey === currentActiveDrawerKey

  const handleOpenEditDrawer = useCallback(() => {
    if (flow.flow.type === 'active') {
      setActiveEditDrawerKey(String(flow.flow.index))
    }
  }, [flow.flow])

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

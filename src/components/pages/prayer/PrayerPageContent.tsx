import { Box, Button } from '@mui/material'
import type { PrayerFlowController } from './usePrayerFlow'
import PrayerActiveView from './PrayerActiveView'
import PrayerFinishedView from './PrayerFinishedView'
import PrayerOverviewPanel from './PrayerOverviewPanel'
import PrayerStepper from './PrayerStepper'
import GoalDialog from '../../dialogs/GoalDialog'
import BasePage from '../BasePage'
import { BackIcon, NextIcon } from '../../Icons'

type PrayerPageContentProps = {
  flow: PrayerFlowController
  isEditDrawerOpen: boolean
  isGoalDialogOpen: boolean
  onCloseEditDrawer: () => void
  onCloseGoalDialog: () => void
  onEditGoal: () => void
  onOpenEditDrawer: () => void
}

export default function PrayerPageContent({
  flow,
  isEditDrawerOpen,
  isGoalDialogOpen,
  onCloseEditDrawer,
  onCloseGoalDialog,
  onEditGoal,
  onOpenEditDrawer,
}: PrayerPageContentProps) {
  const { actions } = flow

  return (
    <BasePage noScrollContainer>
      <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        <Box sx={{ flexGrow: 1, minHeight: 0, overflow: 'hidden' }}>
          <Box
            sx={{
              display: 'flex',
              height: '100%',
              transform: flow.viewTrackTransform,
              transition: `transform ${flow.transitionDurationMs}ms cubic-bezier(0.25, 0.8, 0.25, 1)`,
              width: '200%',
              willChange: 'transform',
            }}
          >
            <PrayerOverviewPanel
              completed={flow.completed}
              goal={flow.goal}
              naturalGoal={flow.naturalGoal}
              visibleSchedule={flow.visibleSchedule}
              isPrayedForToday={flow.isPrayedForToday}
              onCheck={actions.handleCheck}
              onEditGoal={onEditGoal}
              onItemClick={actions.handleItemClick}
              onStart={actions.handleStartFirst}
              startDisabled={flow.allVisiblePrayed && !flow.canKeepPraying}
              startLabel={flow.startButtonLabel}
            />

            <Box sx={{ bgcolor: 'background.default', position: 'relative', width: '50%' }}>
              {flow.shouldRenderActiveView && (
                <Box
                  aria-hidden={flow.hideActiveView}
                  sx={{
                    inset: 0,
                    pointerEvents: flow.hideActiveView ? 'none' : 'auto',
                    position: 'absolute',
                    visibility: flow.hideActiveView ? 'hidden' : 'visible',
                  }}
                >
                  <PrayerActiveView
                    activeIndex={flow.activeViewIndex}
                    items={flow.localItems}
                    isEditDrawerOpen={isEditDrawerOpen && flow.flow.type === 'active'}
                    onBack={actions.handleBack}
                    onCloseEditDrawer={onCloseEditDrawer}
                    onEditDrawerChange={actions.handleEditDrawerChange}
                    onItemChange={actions.handleChange}
                    onNext={actions.handleNext}
                    onOpenEditDrawer={onOpenEditDrawer}
                  />
                </Box>
              )}
              {flow.overlayFlow?.type === 'finished' && (
                <PrayerFinishedView
                  canKeepPraying={flow.canKeepPraying}
                  onBackToOverview={actions.handleGoToOverview}
                  onKeepPraying={actions.handleKeepPraying}
                  prayedCount={flow.overlayFlow.prayedCount}
                />
              )}
            </Box>
          </Box>
        </Box>

        <PrayerStepper
          activeStep={flow.stepperActiveStep}
          isHomeActive={flow.flow.type !== 'overview'}
          onHomeClick={actions.handleGoToOverview}
          onStepClick={flow.stepperSteps > 0 ? actions.handleStepClick : undefined}
          steps={flow.stepperSteps}
          backButton={flow.showActiveNavButtons ? (
            <Button onClick={actions.handleBack} startIcon={<BackIcon />}>
              Back
            </Button>
          ) : undefined}
          nextButton={flow.showActiveNavButtons
            ? (
              <Button endIcon={<NextIcon />} onClick={actions.handleNext}>
                {flow.isLastActiveStep ? 'Finish' : 'Next'}
              </Button>
            )
            : (
              <Button
                disabled={flow.allVisiblePrayed && !flow.canKeepPraying}
                endIcon={<NextIcon />}
                onClick={actions.handleStartFirst}
              >
                {flow.startButtonLabel}
              </Button>
            )}
        />
      </Box>

      <GoalDialog
        naturalGoal={flow.naturalGoal}
        onClose={onCloseGoalDialog}
        open={isGoalDialogOpen}
      />
    </BasePage>
  )
}
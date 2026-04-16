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
}

export default function PrayerPageContent({ flow }: PrayerPageContentProps) {
  const { actions, state, ui } = flow

  return (
    <BasePage noScrollContainer>
      <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        <Box sx={{ flexGrow: 1, minHeight: 0, overflow: 'hidden' }}>
          <Box
            sx={{
              display: 'flex',
              height: '100%',
              transform: state.viewTrackTransform,
              transition: `transform ${state.transitionDurationMs}ms cubic-bezier(0.25, 0.8, 0.25, 1)`,
              width: '200%',
              willChange: 'transform',
            }}
          >
            <PrayerOverviewPanel
              completed={state.completed}
              goal={state.goal}
              naturalGoal={state.naturalGoal}
              visibleSchedule={state.visibleSchedule}
              isPrayedForToday={state.isPrayedForToday}
              onCheck={actions.handleCheck}
              onEditGoal={actions.handleEditGoal}
              onItemClick={actions.handleItemClick}
              onStart={actions.handleStartFirst}
              startDisabled={state.allVisiblePrayed && !state.canKeepPraying}
              startLabel={state.startButtonLabel}
            />

            <Box sx={{ bgcolor: 'background.default', position: 'relative', width: '50%' }}>
              {state.shouldRenderActiveView && (
                <Box
                  aria-hidden={state.hideActiveView}
                  sx={{
                    inset: 0,
                    pointerEvents: state.hideActiveView ? 'none' : 'auto',
                    position: 'absolute',
                    visibility: state.hideActiveView ? 'hidden' : 'visible',
                  }}
                >
                  <PrayerActiveView
                    activeIndex={state.activeViewIndex}
                    items={state.localItems}
                    isEditDrawerOpen={ui.isEditDrawerOpen && state.flow.type === 'active'}
                    onBack={actions.handleBack}
                    onCloseEditDrawer={actions.handleCloseEditDrawer}
                    onEditDrawerChange={actions.handleEditDrawerChange}
                    onItemChange={actions.handleChange}
                    onNext={actions.handleNext}
                    onOpenEditDrawer={actions.handleOpenEditDrawer}
                  />
                </Box>
              )}
              {state.overlayFlow?.type === 'finished' && (
                <PrayerFinishedView
                  canKeepPraying={state.canKeepPraying}
                  onBackToOverview={actions.handleGoToOverview}
                  onKeepPraying={actions.handleKeepPraying}
                  prayedCount={state.overlayFlow.prayedCount}
                />
              )}
            </Box>
          </Box>
        </Box>

        <PrayerStepper
          activeStep={state.stepperActiveStep}
          isHomeActive={state.flow.type !== 'overview'}
          onHomeClick={actions.handleGoToOverview}
          onStepClick={state.stepperSteps > 0 ? actions.handleStepClick : undefined}
          steps={state.stepperSteps}
          backButton={state.showActiveNavButtons ? (
            <Button onClick={actions.handleBack} startIcon={<BackIcon />}>
              Back
            </Button>
          ) : undefined}
          nextButton={state.showActiveNavButtons
            ? (
              <Button endIcon={<NextIcon />} onClick={actions.handleNext}>
                {state.isLastActiveStep ? 'Finish' : 'Next'}
              </Button>
            )
            : (
              <Button
                disabled={state.allVisiblePrayed && !state.canKeepPraying}
                endIcon={<NextIcon />}
                onClick={actions.handleStartFirst}
              >
                {state.startButtonLabel}
              </Button>
            )}
        />
      </Box>

      <GoalDialog
        naturalGoal={state.naturalGoal}
        onClose={actions.handleCloseGoalDialog}
        open={ui.isGoalDialogOpen}
      />
    </BasePage>
  )
}
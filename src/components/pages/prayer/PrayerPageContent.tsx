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
              onCheck={flow.handleCheck}
              onEditGoal={flow.handleEditGoal}
              onItemClick={flow.handleItemClick}
              onStart={flow.handleStartFirst}
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
                    isEditDrawerOpen={flow.isEditDrawerOpen && flow.flow.type === 'active'}
                    onBack={flow.handleBack}
                    onCloseEditDrawer={flow.handleCloseEditDrawer}
                    onEditDrawerChange={flow.handleEditDrawerChange}
                    onItemChange={flow.handleChange}
                    onNext={flow.handleNext}
                    onOpenEditDrawer={flow.handleOpenEditDrawer}
                  />
                </Box>
              )}
              {flow.overlayFlow?.type === 'finished' && (
                <PrayerFinishedView
                  canKeepPraying={flow.canKeepPraying}
                  onBackToOverview={flow.handleGoToOverview}
                  onKeepPraying={flow.handleKeepPraying}
                  prayedCount={flow.overlayFlow.prayedCount}
                />
              )}
            </Box>
          </Box>
        </Box>

        <PrayerStepper
          activeStep={flow.stepperActiveStep}
          isHomeActive={flow.flow.type !== 'overview'}
          onHomeClick={flow.handleGoToOverview}
          onStepClick={flow.stepperSteps > 0 ? flow.handleStepClick : undefined}
          steps={flow.stepperSteps}
          backButton={flow.showActiveNavButtons ? (
            <Button onClick={flow.handleBack} startIcon={<BackIcon />}>
              Back
            </Button>
          ) : undefined}
          nextButton={flow.showActiveNavButtons
            ? (
              <Button endIcon={<NextIcon />} onClick={flow.handleNext}>
                {flow.isLastActiveStep ? 'Finish' : 'Next'}
              </Button>
            )
            : (
              <Button
                disabled={flow.allVisiblePrayed && !flow.canKeepPraying}
                endIcon={<NextIcon />}
                onClick={flow.handleStartFirst}
              >
                {flow.startButtonLabel}
              </Button>
            )}
        />
      </Box>

      <GoalDialog
        naturalGoal={flow.naturalGoal}
        onClose={flow.handleCloseGoalDialog}
        open={flow.isGoalDialogOpen}
      />
    </BasePage>
  )
}
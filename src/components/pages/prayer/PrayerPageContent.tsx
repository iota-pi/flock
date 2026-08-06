import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import IconButton from '@mui/material/IconButton'

import type { PrayerFlowController } from './usePrayerFlow'
import PrayerActiveView from './PrayerActiveView'
import PrayerFinishedView from './PrayerFinishedView'
import PrayerOverviewPanel from './PrayerOverviewPanel'
import PrayerStepper from './PrayerStepper'
import GoalDialog from '../../dialogs/GoalDialog'
import BasePage from '../BasePage'
import { BackIcon, NextIcon, SaveIcon } from '../../Icons'


type PrayerPageContentProps = {
  flow: PrayerFlowController
  isGoalDialogOpen: boolean
  onCloseGoalDialog: () => void
  onEditGoal: () => void
}

export default function PrayerPageContent({
  flow,
  isGoalDialogOpen,
  onCloseGoalDialog,
  onEditGoal,
}: PrayerPageContentProps) {
  const { actions, progress, schedule, stepper, view } = flow

  return (
    <BasePage noScrollContainer>
      <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        <Box sx={{ flexGrow: 1, minHeight: 0, overflow: 'hidden' }}>
          <Box
            sx={{
              display: 'flex',
              height: '100%',
              transform: view.trackTransform,
              transition: `transform ${view.transitionDurationMs}ms cubic-bezier(0.25, 0.8, 0.25, 1)`,
              width: '200%',
              willChange: 'transform',
            }}
          >
            <PrayerOverviewPanel
              completed={progress.completed}
              goal={progress.goal}
              naturalGoal={progress.naturalGoal}
              visibleScheduleIds={schedule.visibleItemsIds}
              isPrayedForToday={schedule.isPrayedForToday}
              onCheck={actions.handleCheck}
              onEditGoal={onEditGoal}
              onItemClick={actions.handleItemClick}
              onStart={actions.handleStartFirst}
              startDisabled={progress.allVisiblePrayed && !progress.canKeepPraying}
              startLabel={view.startButtonLabel}
            />

            <Box sx={{ bgcolor: 'background.default', position: 'relative', width: '50%' }}>
              {view.shouldRenderActive && (
                <Box
                  aria-hidden={view.hideActive}
                  sx={{
                    inset: 0,
                    pointerEvents: view.hideActive ? 'none' : 'auto',
                    position: 'absolute',
                    visibility: view.hideActive ? 'hidden' : 'visible',
                  }}
                >
                  <PrayerActiveView
                    activeIndex={view.activeIndex}
                    items={schedule.visibleItems}
                    onBack={actions.handleBack}
                    onItemChange={actions.handleChange}
                    onNext={actions.handleNext}
                  />
                </Box>
              )}
              {view.overlay?.type === 'finished' && (
                <PrayerFinishedView
                  canKeepPraying={progress.canKeepPraying}
                  onBackToOverview={actions.handleGoToOverview}
                  onKeepPraying={actions.handleKeepPraying}
                  prayedCount={view.overlay.prayedCount}
                />
              )}
            </Box>
          </Box>
        </Box>

        <PrayerStepper
          activeStep={stepper.activeStep}
          isHomeActive={view.current.type !== 'overview'}
          onHomeClick={actions.handleGoToOverview}
          onStepClick={stepper.steps > 0 ? actions.handleStepClick : undefined}
          steps={stepper.steps}
          backButton={view.showActiveNavButtons ? (
            <IconButton
              aria-label="Previous item"
              color="primary"
              onClick={actions.handleBack}
            >
              <BackIcon />
            </IconButton>
          ) : undefined}
          nextButton={
            <IconButton
              aria-label={view.isLastActiveStep ? 'Finish prayer' : 'Next item'}
              color="primary"
              onClick={
                view.showActiveNavButtons
                  ? actions.handleNext
                  : actions.handleStartFirst
              }
            >
              <NextIcon />
            </IconButton>
          }
        />
      </Box>

      <GoalDialog
        naturalGoal={progress.naturalGoal}
        onClose={onCloseGoalDialog}
        open={isGoalDialogOpen}
      />
    </BasePage>
  )
}
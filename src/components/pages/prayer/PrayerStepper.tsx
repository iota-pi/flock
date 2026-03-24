import { ReactNode, useCallback } from 'react'
import { Box, IconButton } from '@mui/material'
import { HomeIcon } from '../../Icons'

interface Props {
  steps: number,
  activeStep?: number,
  backButton?: ReactNode,
  nextButton?: ReactNode,
  onStepClick?: (index: number) => void,
  onHomeClick?: () => void,
  isHomeActive?: boolean,
}

function PrayerStepper({
  steps,
  activeStep,
  backButton,
  nextButton,
  onStepClick,
  onHomeClick,
  isHomeActive = false,
}: Props) {
  const ACTION_SLOT_WIDTH = 144

  const getBackgroundColor = useCallback(
    (index: number) => {
      if (activeStep === undefined) {
        return 'action.disabledBackground'
      }

      if (index < activeStep) {
        return 'primary.dark'
      }

      if (index === activeStep) {
        return 'primary.light'
      }

      return 'action.disabledBackground'
    },
    [activeStep],
  )

  if (steps <= 0) {
    return null
  }

  return (
    <Box
      sx={{
        alignItems: 'center',
        backgroundColor: 'background.paper',
        borderTop: 1,
        borderColor: 'divider',
        display: 'flex',
        gap: 1,
        minHeight: 56,
        px: 2,
        py: 1,
      }}
    >
      <Box sx={{ display: 'flex', justifyContent: 'flex-start', minWidth: 40 }}>
        <IconButton
          aria-label="Go to prayer overview"
          onClick={onHomeClick}
          size="small"
          disabled={!isHomeActive}
          color="primary"
        >
          <HomeIcon fontSize="small" />
        </IconButton>
      </Box>

      <Box
        sx={{
          display: 'flex',
          flexShrink: 0,
          justifyContent: 'flex-start',
          width: ACTION_SLOT_WIDTH,
        }}
      >
        {backButton}
      </Box>

      <Box sx={{ display: 'flex', flexGrow: 1, gap: 1, justifyContent: 'center' }}>
        {Array.from({ length: steps }, (_, index) => (
          <Box
            key={index}
            onClick={onStepClick ? () => onStepClick(index) : undefined}
            sx={{
              backgroundColor: getBackgroundColor(index),
              borderRadius: '50%',
              cursor: onStepClick ? 'pointer' : 'default',
              height: 8,
              transition: theme => theme.transitions.create('background-color'),
              width: 8,
            }}
          />
        ))}
      </Box>

      <Box
        sx={{
          display: 'flex',
          flexShrink: 0,
          justifyContent: 'flex-end',
          width: ACTION_SLOT_WIDTH,
        }}
      >
        {nextButton}
      </Box>
    </Box>
  )
}

export default PrayerStepper

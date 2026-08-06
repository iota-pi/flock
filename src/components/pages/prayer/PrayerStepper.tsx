import { ReactNode, useCallback } from 'react'
import Box from '@mui/material/Box'
import IconButton from '@mui/material/IconButton'

import { OverviewIcon } from '../../Icons'


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

  const getStepState = useCallback(
    (index: number): 'complete' | 'active' | 'pending' => {
      if (activeStep === undefined) {
        return 'pending'
      }

      if (index < activeStep) {
        return 'complete'
      }

      if (index === activeStep) {
        return 'active'
      }

      return 'pending'
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
        borderColor: 'divider',
        borderTop: 1,
        display: 'flex',
        gap: 1,
        minHeight: 56,
        px: 2,
        py: 1,
      }}
    >
      <Box
        sx={{
          alignItems: 'center',
          display: 'flex',
          flex: 1,
          justifyContent: 'flex-start',
          minWidth: 0,
        }}
      >
        {backButton}
      </Box>

      <Box
        sx={{
          alignItems: 'center',
          display: 'flex',
          flex: '0 1 auto',
          gap: 1,
          justifyContent: 'center',
          minWidth: 0,
        }}
      >
        <IconButton
          aria-label="Go to prayer overview"
          data-cy="prayer-step-overview"
          data-state={!isHomeActive ? 'active' : 'complete'}
          disabled={!isHomeActive}
          onClick={onHomeClick}
          size="small"
          sx={{
            color: !isHomeActive
              ? 'primary.light'
              : (activeStep !== undefined ? 'primary.dark' : 'action.disabledBackground'),
            p: 0.25,
            transition: theme => theme.transitions.create('color'),
          }}
        >
          <OverviewIcon sx={{ fontSize: '1rem' }} />
        </IconButton>

        {Array.from({ length: steps }, (_, index) => (
          <Box
            key={index}
            data-cy={`prayer-step-${index}`}
            data-state={getStepState(index)}
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
          alignItems: 'center',
          display: 'flex',
          flex: 1,
          justifyContent: 'flex-end',
          minWidth: 0,
        }}
      >
        {nextButton}
      </Box>
    </Box>
  )
}

export default PrayerStepper

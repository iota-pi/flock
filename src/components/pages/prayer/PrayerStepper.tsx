import { ReactNode, useCallback } from 'react'
import { Box } from '@mui/material'

interface Props {
  steps: number,
  activeStep?: number,
  backButton?: ReactNode,
  nextButton?: ReactNode,
}

function PrayerStepper({
  steps,
  activeStep,
  backButton,
  nextButton,
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
        gap: 2,
        minHeight: 56,
        px: 2,
        py: 1,
      }}
    >
      <Box sx={{ display: 'flex', justifyContent: 'flex-start', minWidth: 80 }}>
        {backButton}
      </Box>

      <Box sx={{ display: 'flex', flexGrow: 1, gap: 1, justifyContent: 'center' }}>
        {Array.from({ length: steps }, (_, index) => (
          <Box
            key={index}
            sx={{
              backgroundColor: getBackgroundColor(index),
              borderRadius: '50%',
              height: 8,
              transition: theme => theme.transitions.create('background-color'),
              width: 8,
            }}
          />
        ))}
      </Box>

      <Box sx={{ display: 'flex', justifyContent: 'flex-end', minWidth: 80 }}>
        {nextButton}
      </Box>
    </Box>
  )
}

export default PrayerStepper

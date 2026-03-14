import {
  Box,
  Button,
  Typography,
} from '@mui/material'
import InlineText from '../../InlineText'
import {
  BackIcon,
  NextIcon,
  PrayerIcon,
} from '../../Icons'
import BasePage from '../BasePage'

interface Props {
  prayedCount: number,
  canKeepPraying: boolean,
  onKeepPraying: () => void,
  onBackToOverview: () => void,
}

function PrayerFinishedView({
  prayedCount,
  canKeepPraying,
  onKeepPraying,
  onBackToOverview,
}: Props) {
  return (
    <BasePage noScrollContainer>
      <Box
        sx={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 2,
          p: 4,
          textAlign: 'center',
        }}
      >
        <PrayerIcon sx={{ fontSize: 90 }} />
        <Typography variant="h5">All done!</Typography>
        <Typography color="text.secondary">
          {'You prayed for '}
          <InlineText variant="inherit" fontWeight="fontWeightMedium">
            {prayedCount}
          </InlineText>
          {` item${prayedCount !== 1 ? 's' : ''} today.`}
        </Typography>

        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <Button
            data-cy="keep-praying"
            disabled={!canKeepPraying}
            endIcon={<NextIcon />}
            fullWidth
            onClick={onKeepPraying}
            size="large"
            variant="outlined"
          >
            Keep Praying
          </Button>
          <Button
            fullWidth
            onClick={onBackToOverview}
            size="large"
            startIcon={<BackIcon />}
            variant="contained"
          >
            Back to Overview
          </Button>
        </Box>
      </Box>
    </BasePage>
  )
}

export default PrayerFinishedView

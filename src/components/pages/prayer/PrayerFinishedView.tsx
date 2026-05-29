import Button from '@mui/material/Button'
import Typography from '@mui/material/Typography'
import Box from '@mui/material/Box'

import InlineText from '../../ui/InlineText'
import LargeIcon from 'src/components/ui/LargeIcon'
import {
  BackIcon,
  NextIcon,
  PrayerIcon,
} from '../../Icons'


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
      <LargeIcon icon={PrayerIcon} />
      <Typography variant="h5">All done!</Typography>
      <Typography sx={{
        color: "text.secondary"
      }}>
        {'You prayed for '}
        <InlineText variant="inherit">
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
  )
}

export default PrayerFinishedView

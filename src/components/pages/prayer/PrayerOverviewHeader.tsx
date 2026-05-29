import { Fragment } from 'react'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Divider from '@mui/material/Divider'
import Grid from '@mui/material/Grid'
import IconButton from '@mui/material/IconButton'
import Typography from '@mui/material/Typography'
import useMediaQuery from '@mui/material/useMediaQuery'

import {
  EditIcon,
  NextIcon,
} from '../../Icons'

interface Props {
  completed: number,
  goal: number,
  naturalGoal: number,
  visibleScheduleLength: number,
  startLabel: string,
  startDisabled?: boolean,
  onEditGoal: () => void,
  onStart: () => void,
}

function PrayerOverviewHeader({
  completed,
  goal,
  naturalGoal,
  startDisabled,
  startLabel,
  visibleScheduleLength,
  onEditGoal,
  onStart,
}: Props) {
  const xs = useMediaQuery(theme => theme.breakpoints.down('sm'))

  return (
    <Fragment>
      <Grid
        container
        spacing={2}
        sx={{ px: 2, py: xs ? 1 : 2 }}
      >
        <Grid size={{ xs: 12 }} sx={{ display: 'flex', alignItems: 'center' }}>
          <Typography>
            {'Daily Goal: '}
            {completed}
            {' / '}
            <Typography
              color={goal < naturalGoal ? 'secondary' : 'textPrimary'}
              component="span"
            >
              {goal}
            </Typography>
          </Typography>

          <IconButton
            aria-label="Edit prayer goal"
            size="medium"
            onClick={onEditGoal}
            sx={{ ml: 1 }}
            data-cy="edit-goal"
          >
            <EditIcon fontSize="small" />
          </IconButton>

          <Box sx={{ flexGrow: 1 }} />

          <Button
            data-cy="start-prayer"
            disabled={visibleScheduleLength === 0 || startDisabled}
            endIcon={<NextIcon />}
            onClick={onStart}
          >
            {startLabel}
          </Button>
        </Grid>
      </Grid>
      <Divider />
    </Fragment>
  )
}

export default PrayerOverviewHeader

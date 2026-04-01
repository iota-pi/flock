import { Fragment } from 'react'
import {
  Box,
  Button,
  Divider,
  Grid,
  IconButton,
  Typography,
} from '@mui/material'
import {
  EditIcon,
  NextIcon,
} from '../../Icons'
import PageContainer from '../../ui/PageContainer'

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
  return (
    <Fragment>
      <PageContainer maxWidth="xl">
        <Grid container spacing={2}>
          <Grid size={{ xs: 12 }} display="flex" alignItems="center">
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
              size="small"
              variant="contained"
            >
              {startLabel}
            </Button>
          </Grid>
        </Grid>
      </PageContainer>
      <Divider />
    </Fragment>
  )
}

export default PrayerOverviewHeader

import { ChangeEvent, useCallback, useState } from 'react'
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  InputAdornment,
  TextField,
  Typography,
} from '@mui/material'
import { useMetadata } from '../../state/selectors'
import { ResetIcon, SaveIcon, WarningIcon } from '../Icons'

export interface Props {
  naturalGoal: number,
  onClose: () => void,
  open: boolean,
}


function GoalDialog({
  naturalGoal,
  onClose,
  open,
}: Props) {
  const [goal, setGoal] = useMetadata('prayerGoal', naturalGoal)
  const [newGoal, setNewGoal] = useState(goal.toString())
  const [prevOpen, setPrevOpen] = useState(open)
  if (open !== prevOpen) {
    setPrevOpen(open)
    if (open) {
      setNewGoal(goal.toString())
    }
  }

  const numericValue = parseInt(newGoal)
  const hintMessage = numericValue > 0 ? undefined : 'Please enter a positive number'
  const error = !!hintMessage
  const warning = !!newGoal && parseInt(newGoal) < naturalGoal

  const handleChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const value = event.target.value
      setNewGoal(value)
    },
    [],
  )
  const handleDone = useCallback(
    () => {
      if (!error && parseInt(newGoal) !== goal) {
        setGoal(parseInt(newGoal))
      }
      onClose()
    },
    [error, goal, newGoal, onClose, setGoal],
  )
  const handleReset = useCallback(
    () => {
      setNewGoal(naturalGoal.toString())
    },
    [naturalGoal],
  )

  return (
    <Dialog
      open={open}
      onClose={onClose}
    >
      <DialogTitle>
        Customise Daily Prayer Goal
      </DialogTitle>

      <DialogContent>
        <Typography paragraph>
          To get through all your prayer items in the target time,
          set to
          {' '}
          <Typography component="span" fontWeight={500}>{naturalGoal}</Typography>
          {' '}
          or higher.
        </Typography>

        <div>
          <TextField
            error={error}
            fullWidth
            helperText={hintMessage}
            label="Prayer Goal"
            onChange={handleChange}
            type="number"
            value={newGoal}
            variant="outlined"
            slotProps={{
              input: {
                endAdornment: (
                  <InputAdornment position="end">
                    <IconButton
                      disabled={parseInt(newGoal) === naturalGoal}
                      onClick={handleReset}
                      size="large"
                    >
                      <ResetIcon />
                    </IconButton>
                  </InputAdornment>
                ),
              }
            }}
            inputProps={{ 'data-cy': 'dialog-goal-input' }}
          />
        </div>
      </DialogContent>

      <DialogActions>
        <Button
          onClick={onClose}
          variant="outlined"
          fullWidth
          data-cy='dialog-cancel'
        >
          Cancel
        </Button>

        <Button
          disabled={error}
          color={warning ? 'secondary' : 'primary'}
          fullWidth
          onClick={handleDone}
          startIcon={warning ? <WarningIcon /> : <SaveIcon />}
          variant="contained"
          data-cy='dialog-confirm'
        >
          Done
        </Button>
      </DialogActions>
    </Dialog>
  )
}

export default GoalDialog

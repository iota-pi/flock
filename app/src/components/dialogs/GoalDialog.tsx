import { ChangeEvent, useCallback, useEffect, useState } from 'react';
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
} from '@material-ui/core';
import { useMetadata } from '../../state/selectors';
import { ResetIcon, SaveIcon, WarningIcon } from '../Icons';

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
  const [goal, setGoal] = useMetadata<number>('prayerGoal', naturalGoal);
  const [newGoal, setNewGoal] = useState(goal.toString());
  const [hintMessage, setHintMessage] = useState<string>();
  const error = !!hintMessage;
  const warning = !!newGoal && parseInt(newGoal) < naturalGoal;

  useEffect(
    () => {
      if (open) {
        setNewGoal(goal.toString());
        setHintMessage(undefined);
      }
    },
    [goal, open],
  );

  const handleChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const value = event.target.value;
      setNewGoal(value);

      const numericValue = parseInt(value);
      if (numericValue > 0) {
        setHintMessage(undefined);
      } else {
        setHintMessage('Please enter a positive number');
      }
    },
    [],
  );
  const handleDone = useCallback(
    () => {
      if (!error && parseInt(newGoal) !== goal) {
        setGoal(parseInt(newGoal));
      }
      onClose();
    },
    [error, goal, newGoal, onClose, setGoal],
  );
  const handleReset = useCallback(
    () => {
      setNewGoal(naturalGoal.toString());
    },
    [naturalGoal],
  );

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
          we recommend setting this value to at least
          {' '}
          <Typography display="inline" fontWeight={500}>{naturalGoal}</Typography>.
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
            InputProps={{
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
            }}
          />
        </div>
      </DialogContent>

      <DialogActions>
        <Button
          onClick={onClose}
          variant="outlined"
          fullWidth
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
        >
          Done
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default GoalDialog;

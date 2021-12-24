import {
  Box,
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
  IconButton,
  MenuItem,
  Stack,
  styled,
  TextField,
} from '@material-ui/core';
import { ChangeEvent, useCallback, useEffect, useState } from 'react';
import { useVault } from '../../state/selectors';
import { checkSubscription } from '../../utils/firebase';
import { RemoveIcon } from '../Icons';

export interface Props {
  onClose: () => void,
  onSave: (hours: number[] | null) => void,
  open: boolean,
}

interface SubscriptionHour {
  hour: number,
  id: number,
}

const hourOptions = [
  { text: '12am', value: 0 },
  { text: '1am', value: 1 },
  { text: '2am', value: 2 },
  { text: '3am', value: 3 },
  { text: '4am', value: 4 },
  { text: '5am', value: 5 },
  { text: '6am', value: 6 },
  { text: '7am', value: 7 },
  { text: '8am', value: 8 },
  { text: '9am', value: 9 },
  { text: '10am', value: 10 },
  { text: '11am', value: 11 },
  { text: '12pm', value: 12 },
  { text: '1pm', value: 13 },
  { text: '2pm', value: 14 },
  { text: '3pm', value: 15 },
  { text: '4pm', value: 16 },
  { text: '5pm', value: 17 },
  { text: '6pm', value: 18 },
  { text: '7pm', value: 19 },
  { text: '8pm', value: 20 },
  { text: '9pm', value: 21 },
  { text: '10pm', value: 22 },
  { text: '11pm', value: 23 },
];

const DialogContentNarrowPadding = styled(DialogContent)(({ theme }) => ({
  padding: theme.spacing(2),
}));

function SubscriptionDialog({
  onClose,
  onSave,
  open,
}: Props) {
  const vault = useVault();
  const [hours, setHours] = useState<SubscriptionHour[]>([]);

  useEffect(
    () => {
      if (vault) {
        checkSubscription(vault).then(existing => {
          if (existing) {
            setHours(
              existing.hours.map(hour => ({
                hour,
                id: Math.random(),
              })),
            );
          } else {
            setHours([]);
          }
        }).catch(console.error);
      }
    },
    [vault],
  );

  const handleSave = useCallback(
    () => {
      if (hours.length > 0) {
        const hoursPlain = hours.map(hour => hour.hour);
        onSave(hoursPlain);
      } else {
        onSave(null);
      }
    },
    [hours, onSave],
  );
  const handleChange = useCallback(
    (id: number) => (
      (event: ChangeEvent<HTMLInputElement>) => setHours(
        oldHours => {
          const index = oldHours.findIndex(h => h.id === id);
          const hour = +event.target.value;
          return [
            ...oldHours.slice(0, index),
            { ...oldHours[index], hour },
            ...oldHours.slice(index + 1),
          ];
        },
      )
    ),
    [],
  );
  const handleAdd = useCallback(
    () => setHours(
      oldHours => [
        ...oldHours,
        { hour: new Date().getHours(), id: Math.random() },
      ],
    ),
    [],
  );
  const handleRemove = useCallback(
    (id: number) => () => setHours(oldHours => {
      const index = oldHours.findIndex(hour => hour.id === id);
      return [
        ...oldHours.slice(0, index),
        ...oldHours.slice(index + 1),
      ];
    }),
    [],
  );

  return (
    <Dialog
      open={open}
      onClose={onClose}
    >
      <DialogTitle>
        Manage Notifications
      </DialogTitle>

      <DialogContentNarrowPadding>
        You can opt-in to receive daily prayer reminders.

        <Stack
          spacing={1}
          paddingY={2}
        >
          {hours.map(({ hour, id }) => (
            <Box
              alignItems="center"
              display="flex"
              key={id}
            >
              <TextField
                fullWidth
                label="Notification time"
                select
                onChange={handleChange(id)}
                value={hour}
              >
                {hourOptions.map(hourOption => (
                  <MenuItem
                    key={hourOption.text}
                    value={hourOption.value}
                  >
                    {hourOption.text}
                  </MenuItem>
                ))}
              </TextField>

              <IconButton onClick={handleRemove(id)}>
                <RemoveIcon />
              </IconButton>
            </Box>
          ))}
        </Stack>

        <Stack spacing={1}>
          <Stack>
            <Button
              data-cy="subscription-add-time"
              disabled={hours.length > 0}
              fullWidth
              onClick={handleAdd}
              variant="outlined"
            >
              Add Notification
            </Button>
          </Stack>

          <Stack spacing={1} direction="row">
            <Button
              data-cy="subscription-cancel"
              fullWidth
              onClick={onClose}
              variant="outlined"
            >
              Cancel
            </Button>

            <Button
              color="primary"
              data-cy="subscription-confirm"
              fullWidth
              onClick={handleSave}
              variant="contained"
            >
              Save
            </Button>
          </Stack>
        </Stack>
      </DialogContentNarrowPadding>
    </Dialog>
  );
}

export default SubscriptionDialog;

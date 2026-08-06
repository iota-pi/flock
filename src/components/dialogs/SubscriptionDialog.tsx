import { ChangeEvent, useCallback, useEffect, useState } from 'react'
import Button from '@mui/material/Button'
import Dialog from '@mui/material/Dialog'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import TextField from '@mui/material/TextField'
import Stack from '@mui/material/Stack'
import MenuItem from '@mui/material/MenuItem'
import FormControlLabel from '@mui/material/FormControlLabel'
import Switch from '@mui/material/Switch'
import Typography from '@mui/material/Typography'
import CircularProgress from '@mui/material/CircularProgress'
import { styled } from '@mui/material/styles'

import { checkSubscription } from '../../utils/pushNotifications'
import { useAppStore } from 'src/state/store'

interface Props {
  onClose: () => void,
  onSave: (hours: number[] | null) => Promise<void>,
  open: boolean,
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
]

const DialogContentNarrowPadding = styled(DialogContent)(({ theme }) => ({
  padding: theme.spacing(2),
}))

function SubscriptionDialog({
  onClose,
  onSave,
  open,
}: Props) {
  const account = useAppStore(state => state.account)
  const [enabled, setEnabled] = useState(false)
  const [hour, setHour] = useState(8)
  const [saving, setSaving] = useState(false)

  useEffect(
    () => {
      if (!account) {
        return
      }

      let cancelled = false
      checkSubscription(account).then(existing => {
        if (cancelled) {
          return
        }
        if (existing && existing.hours.length > 0) {
          setEnabled(true)
          setHour(existing.hours[0])
        } else {
          setEnabled(false)
          setHour(8)
        }
      }).catch(console.error)
      return () => { cancelled = true }
    },
    [account, open],
  )

  const handleSave = useCallback(
    async () => {
      setSaving(true)
      try {
        if (enabled) {
          await onSave([hour])
        } else {
          await onSave(null)
        }
      } finally {
        setSaving(false)
      }
    },
    [enabled, hour, onSave],
  )

  const handleToggleEnabled = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      setEnabled(event.target.checked)
    },
    [],
  )

  const handleHourChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      setHour(Number(event.target.value))
    },
    [],
  )

  return (
    <Dialog
      open={open}
      onClose={saving ? undefined : onClose}
      fullWidth
      maxWidth="sm"
    >
      <DialogTitle>
        Manage Notifications
      </DialogTitle>
      <DialogContentNarrowPadding>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          You can opt-in to receive daily prayer reminders.
        </Typography>

        <Stack spacing={2} sx={{ py: 1 }}>
          <FormControlLabel
            control={
              <Switch
                checked={enabled}
                disabled={saving}
                onChange={handleToggleEnabled}
                color="primary"
                data-cy="subscription-toggle"
              />
            }
            label="Enable daily prayer reminder"
          />

          {enabled && (
            <TextField
              disabled={saving}
              fullWidth
              label="Notification time"
              select
              onChange={handleHourChange}
              value={hour}
              data-cy="subscription-time-select"
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
          )}
        </Stack>

        <Stack spacing={1} direction="row" sx={{ mt: 3 }}>
          <Button
            data-cy="subscription-cancel"
            disabled={saving}
            fullWidth
            onClick={onClose}
            variant="outlined"
          >
            Cancel
          </Button>

          <Button
            color="primary"
            data-cy="subscription-confirm"
            disabled={saving}
            fullWidth
            onClick={handleSave}
            variant="contained"
            startIcon={saving ? <CircularProgress size={18} color="inherit" /> : null}
          >
            {saving ? 'Saving...' : 'Save'}
          </Button>
        </Stack>
      </DialogContentNarrowPadding>
    </Dialog>
  )
}

export default SubscriptionDialog

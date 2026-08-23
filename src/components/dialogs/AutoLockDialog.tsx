import { useCallback, useState } from 'react'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import FormControl from '@mui/material/FormControl'
import FormControlLabel from '@mui/material/FormControlLabel'
import InputLabel from '@mui/material/InputLabel'
import MenuItem from '@mui/material/MenuItem'
import Radio from '@mui/material/Radio'
import RadioGroup from '@mui/material/RadioGroup'
import Select, { SelectChangeEvent } from '@mui/material/Select'
import Typography from '@mui/material/Typography'

import {
  AutoLockMode,
  AutoLockSettings,
  INACTIVITY_PRESETS,
  readAutoLockSettings,
} from '../../api/vault/autoLockStore'
import { SaveIcon } from '../Icons'

interface Props {
  onClose: () => void
  onSave: (settings: AutoLockSettings) => void
  open: boolean
}

export default function AutoLockDialog({ onClose, onSave, open }: Props) {
  const [initialSettings] = useState(() => readAutoLockSettings())
  const [mode, setMode] = useState<AutoLockMode>(initialSettings.mode)
  const [inactivityMinutes, setInactivityMinutes] = useState<number>(initialSettings.inactivityMinutes)
  const [prevOpen, setPrevOpen] = useState(open)

  if (open !== prevOpen) {
    setPrevOpen(open)
    if (open) {
      const current = readAutoLockSettings()
      setMode(current.mode)
      setInactivityMinutes(current.inactivityMinutes)
    }
  }

  const handleModeChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    setMode(event.target.value as AutoLockMode)
  }, [])

  const handleMinutesChange = useCallback((event: SelectChangeEvent<number>) => {
    setInactivityMinutes(Number(event.target.value))
  }, [])

  const handleSave = useCallback(() => {
    onSave({
      mode,
      inactivityMinutes,
    })
    onClose()
  }, [inactivityMinutes, mode, onClose, onSave])

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle>Auto-Lock Settings</DialogTitle>

      <DialogContent>
        <Typography variant="body2" color="textSecondary" sx={{ mb: 2 }}>
          Choose when Flock should automatically lock on this device.
        </Typography>

        <FormControl component="fieldset" fullWidth>
          <RadioGroup value={mode} onChange={handleModeChange}>
            <FormControlLabel
              value="never"
              control={<Radio data-cy="autolock-never" />}
              label="Never"
            />
            <FormControlLabel
              value="focus"
              control={<Radio data-cy="autolock-focus" />}
              label="When the app loses focus"
            />
            <FormControlLabel
              value="inactivity"
              control={<Radio data-cy="autolock-inactivity" />}
              label="After a period of inactivity"
            />
          </RadioGroup>
        </FormControl>

        {mode === 'inactivity' && (
          <Box sx={{ mt: 2, pl: 4 }}>
            <FormControl fullWidth size="small">
              <InputLabel id="inactivity-minutes-label">Inactivity Duration</InputLabel>
              <Select<number>
                labelId="inactivity-minutes-label"
                id="inactivity-minutes"
                value={inactivityMinutes}
                label="Inactivity Duration"
                onChange={handleMinutesChange}
                data-cy="autolock-minutes-select"
              >
                {INACTIVITY_PRESETS.map(preset => (
                  <MenuItem key={preset} value={preset}>
                    {preset} {preset === 1 ? 'minute' : 'minutes'}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          </Box>
        )}
      </DialogContent>

      <DialogActions>
        <Button onClick={onClose} variant="outlined" fullWidth data-cy="dialog-cancel">
          Cancel
        </Button>
        <Button
          color="primary"
          fullWidth
          onClick={handleSave}
          startIcon={<SaveIcon />}
          variant="contained"
          data-cy="dialog-confirm"
        >
          Save
        </Button>
      </DialogActions>
    </Dialog>
  )
}

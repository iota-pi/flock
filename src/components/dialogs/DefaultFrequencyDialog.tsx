import { useCallback, useState, useEffect } from 'react'
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Grid,
  Typography,
} from '@mui/material'
import FrequencyPicker from '../FrequencyPicker'
import { Frequency } from '../../utils/frequencies'
import { PersonIcon, GroupIcon } from '../Icons'

export interface Defaults {
  person?: Frequency,
  group?: Frequency,
}

export interface Props {
  open: boolean,
  defaults: Defaults,
  onClose: () => void,
  onSave: (d: Defaults) => void,
}

function DefaultFrequencyDialog({ open, defaults, onClose, onSave }: Props) {
  const [person, setPerson] = useState<Frequency>(defaults.person ?? 'monthly')
  const [group, setGroup] = useState<Frequency>(defaults.group ?? 'monthly')

  useEffect(() => {
    setPerson(defaults.person ?? 'monthly')
    setGroup(defaults.group ?? 'monthly')
  }, [defaults])

  const handleSave = useCallback(() => {
    onSave({ person, group })
    onClose()
  }, [person, group, onSave, onClose])

  return (
    <Dialog onClose={onClose} open={open} fullWidth maxWidth="sm">
      <DialogTitle>Default Prayer Frequency</DialogTitle>
      <DialogContent>
        <Grid container spacing={2} alignItems="center">
          <Grid size={{ xs: 12, sm: 6 }}>
            <Typography variant="subtitle1">People</Typography>
            <FrequencyPicker
              frequency={person}
              onChange={setPerson}
              fullWidth
              icon={<PersonIcon />}
              label="Default for People"
            />
          </Grid>

          <Grid size={{ xs: 12, sm: 6 }}>
            <Typography variant="subtitle1">Groups</Typography>
            <FrequencyPicker
              frequency={group}
              onChange={setGroup}
              fullWidth
              icon={<GroupIcon />}
              label="Default for Groups"
            />
          </Grid>
        </Grid>
      </DialogContent>
      <DialogActions>
        <Button variant="outlined" fullWidth onClick={handleSave}>Save</Button>
      </DialogActions>
    </Dialog>
  )
}

export default DefaultFrequencyDialog

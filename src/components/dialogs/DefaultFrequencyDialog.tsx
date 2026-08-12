import { useCallback, useState } from 'react'
import Button from '@mui/material/Button'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import Grid from '@mui/material/Grid'
import Typography from '@mui/material/Typography'

import FrequencyPicker from '../FrequencyPicker'
import { Frequency } from '../../utils/frequencies'
import { PersonIcon, GroupIcon, TopicIcon } from '../Icons'


export interface Defaults {
  person?: Frequency,
  group?: Frequency,
  topic?: Frequency,
}

interface Props {
  open: boolean,
  defaults: Defaults,
  onClose: () => void,
  onSave: (d: Defaults) => void,
}

function DefaultFrequencyDialog({ open, defaults, onClose, onSave }: Props) {
  const [person, setPerson] = useState<Frequency>(defaults.person ?? 'none')
  const [group, setGroup] = useState<Frequency>(defaults.group ?? 'none')
  const [topic, setTopic] = useState<Frequency>(defaults.topic ?? 'none')

  const [prevDefaults, setPrevDefaults] = useState(defaults)
  if (defaults !== prevDefaults) {
    setPrevDefaults(defaults)
    setPerson(defaults.person ?? 'none')
    setGroup(defaults.group ?? 'none')
    setTopic(defaults.topic ?? 'none')
  }

  const handleSave = useCallback(() => {
    onSave({ person, group, topic })
    onClose()
  }, [person, group, topic, onSave, onClose])

  return (
    <Dialog onClose={onClose} open={open} fullWidth maxWidth="sm">
      <DialogTitle>Default Prayer Frequency</DialogTitle>
      <DialogContent>
        <Grid container spacing={2} sx={{
          alignItems: "center"
        }}>
          <Grid size={{ xs: 12, sm: 4 }}>
            <Typography variant="subtitle1">People</Typography>
            <FrequencyPicker
              frequency={person}
              onChange={setPerson}
              fullWidth
              icon={<PersonIcon />}
              label="Default for People"
            />
          </Grid>

          <Grid size={{ xs: 12, sm: 4 }}>
            <Typography variant="subtitle1">Groups</Typography>
            <FrequencyPicker
              frequency={group}
              onChange={setGroup}
              fullWidth
              icon={<GroupIcon />}
              label="Default for Groups"
            />
          </Grid>

          <Grid size={{ xs: 12, sm: 4 }}>
            <Typography variant="subtitle1">Topics</Typography>
            <FrequencyPicker
              frequency={topic}
              onChange={setTopic}
              fullWidth
              icon={<TopicIcon />}
              label="Default for Topics"
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

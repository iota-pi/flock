import { useCallback, useState } from 'react'
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Grid,
} from '@mui/material'
import { Item } from '../../state/items'
import { storeItems } from '../../api/Vault'
import { PrayerIcon } from '../Icons'
import FrequencyPicker from '../FrequencyPicker'
import { Frequency } from '../../utils/frequencies'


export interface Props {
  items: Item[],
  onClose: () => void,
  open: boolean,
}


function FrequencyDialog({
  items,
  onClose,
  open,
}: Props) {
  const [frequency, setFrequency] = useState<Frequency>('none')

  const handleDone = useCallback(
    () => {
      const updatedItems: typeof items = []
      for (const item of items) {
        updatedItems.push({
          ...item,
          prayerFrequency: frequency,
        })
      }
      storeItems(updatedItems)
      onClose()
    },
    [frequency, items, onClose],
  )

  return (
    <Dialog
      onClose={onClose}
      open={open}
      fullWidth
      maxWidth="sm"
    >
      <DialogTitle>
        Set Prayer Frequency
      </DialogTitle>

      <DialogContent>
        <Grid item xs={12}>
          <FrequencyPicker
            frequency={frequency}
            fullWidth
            icon={<PrayerIcon />}
            label="Prayer Frequency"
            onChange={setFrequency}
          />
        </Grid>
      </DialogContent>

      <DialogActions>
        <Button
          onClick={handleDone}
          variant="outlined"
          fullWidth
        >
          Save
        </Button>
      </DialogActions>
    </Dialog>
  )
}

export default FrequencyDialog

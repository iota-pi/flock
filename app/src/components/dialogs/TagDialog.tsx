import { useCallback, useEffect, useState } from 'react'
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Grid,
} from '@mui/material'
import { Item } from '../../state/items'
import { usePrevious } from '../../utils'
import TagSelection from '../TagSelection'
import { AddIcon, MinusIcon } from '../Icons'
import { storeItems } from '../../api/Vault'


export interface Props {
  items: Item[],
  onClose: () => void,
  open: boolean,
}

function TagDialog({
  items,
  onClose,
  open,
}: Props) {
  const prevOpen = usePrevious(open)

  const [addTags, setAddTags] = useState<string[]>([])
  const [removeTags, setRemoveTags] = useState<string[]>([])

  useEffect(
    () => {
      if (open && !prevOpen) {
        setAddTags([])
        setRemoveTags([])
      }
    },
    [open, prevOpen],
  )

  const handleChangeAdd = useCallback((tags: string[]) => setAddTags(tags), [])
  const handleChangeRemove = useCallback((tags: string[]) => setRemoveTags(tags), [])
  const handleDone = useCallback(
    () => {
      const updated: Item[] = []
      for (const item of items) {
        const remainingTags = item.tags.filter(tag => !removeTags.includes(tag))
        const newTags = addTags.filter(tag => !item.tags.includes(tag))
        if (remainingTags.length < item.tags.length || newTags.length > 0) {
          const newItem: Item = {
            ...item,
            tags: [...remainingTags, ...newTags],
          }
          updated.push(newItem)
        }
      }
      storeItems(updated)
      onClose()
    },
    [addTags, items, onClose, removeTags],
  )

  return (
    <Dialog
      onClose={onClose}
      open={open}
      fullWidth
      maxWidth="sm"
    >
      <DialogTitle>
        Add/Remove Tags
      </DialogTitle>

      <DialogContent>
        <Grid container spacing={2}>
          <Grid item xs={12}>
            <TagSelection
              icon={AddIcon}
              label="Add Tags"
              onChange={handleChangeAdd}
              selectedTags={addTags}
            />
          </Grid>

          <Grid item xs={12}>
            <TagSelection
              canAddNew={false}
              icon={MinusIcon}
              label="Remove Tags"
              onChange={handleChangeRemove}
              selectedTags={removeTags}
            />
          </Grid>
        </Grid>
      </DialogContent>

      <DialogActions>
        <Button
          disabled={addTags.length + removeTags.length === 0}
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

export default TagDialog

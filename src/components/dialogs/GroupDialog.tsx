import { useCallback, useMemo, useState } from 'react'
import Button from '@mui/material/Button'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import Grid from '@mui/material/Grid'

import { Item } from '../../state/items'
import Search from '../Search'
import { storeItems } from '../../features/items/mutations/itemMutations'
import { GroupItem } from 'src/shared/schemas/items'


interface Props {
  items: Item[],
  onClose: () => void,
  open: boolean,
}


function GroupDialog({
  items,
  onClose,
  open,
}: Props) {
  const [addGroups, setAddGroups] = useState<GroupItem[]>([])
  const [removeGroups, setRemoveGroups] = useState<GroupItem[]>([])

  const removeGroupsIds = useMemo(() => removeGroups.map(g => g.id), [removeGroups])
  const selectedIds = useMemo(() => items.map(item => item.id), [items])

  const [prevOpen, setPrevOpen] = useState(open)
  if (open && !prevOpen) {
    setPrevOpen(true)
    setAddGroups([])
    setRemoveGroups([])
  } else if (!open && prevOpen) {
    setPrevOpen(false)
  }

  const handleClearAdd = useCallback(() => setAddGroups([]), [])
  const handleSelectAdd = useCallback(
    (group: GroupItem) => setAddGroups(ag => [...ag, group]),
    [],
  )
  const handleRemoveAdd = useCallback(
    (group: GroupItem) => setAddGroups(ag => ag.filter(g => g.id !== group.id)),
    [],
  )
  const handleClearRemove = useCallback(() => setRemoveGroups([]), [])
  const handleSelectRemove = useCallback(
    (group: GroupItem) => setRemoveGroups(rg => [...rg, group]),
    [],
  )
  const handleRemoveRemove = useCallback(
    (group: GroupItem) => setRemoveGroups(rg => rg.filter(g => g.id !== group.id)),
    [],
  )
  const handleDone = useCallback(
    () => {
      const updated: GroupItem[] = []
      const filteredAddGroups = addGroups.filter(g => !removeGroupsIds.includes(g.id))
      for (const group of filteredAddGroups) {
        updated.push({
          ...group,
          members: [...group.members, ...selectedIds],
        })
      }
      for (const group of removeGroups) {
        updated.push({
          ...group,
          members: group.members.filter(m => !selectedIds.includes(m)),
        })
      }

      void storeItems(updated)
        .then(() => {
          onClose()
        })
        .catch(error => {
          console.error(error)
        })
    },
    [addGroups, onClose, removeGroups, removeGroupsIds, selectedIds],
  )

  const addGroupsIds = useMemo(() => addGroups.map(g => g.id), [addGroups])

  return (
    <Dialog
      onClose={onClose}
      open={open}
      fullWidth
      maxWidth="sm"
    >
      <DialogTitle>
        Add/Remove from Groups
      </DialogTitle>
      <DialogContent>
        <Grid container spacing={2} sx={{
          paddingTop: 1
        }}>
          <Grid size={{ xs: 12 }}>
            <Search<GroupItem>
              autoFocus
              label="Add to Groups"
              onClear={handleClearAdd}
              onRemove={handleRemoveAdd}
              onSelect={handleSelectAdd}
              selectedItemIds={addGroupsIds}
              showIcons
              showSelectedChips
              types={{ group: true }}
            />
          </Grid>

          <Grid size={{ xs: 12 }}>
            <Search<GroupItem>
              label="Remove from Groups"
              onClear={handleClearRemove}
              onRemove={handleRemoveRemove}
              onSelect={handleSelectRemove}
              selectedItemIds={removeGroupsIds}
              showIcons
              showSelectedChips
              types={{ group: true }}
            />
          </Grid>
        </Grid>
      </DialogContent>
      <DialogActions>
        <Button
          disabled={addGroups.length + removeGroups.length === 0}
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

export default GroupDialog

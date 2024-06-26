import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Grid,
} from '@mui/material'
import { GroupItem, Item } from '../../state/items'
import { usePrevious } from '../../utils'
import Search from '../Search'
import { storeItems } from '../../api/Vault'


export interface Props {
  items: Item[],
  onClose: () => void,
  open: boolean,
}


function GroupDialog({
  items,
  onClose,
  open,
}: Props) {
  const prevOpen = usePrevious(open)

  const [addGroups, setAddGroups] = useState<GroupItem[]>([])
  const [removeGroups, setRemoveGroups] = useState<GroupItem[]>([])

  const removeGroupsIds = useMemo(() => removeGroups.map(g => g.id), [removeGroups])
  const selectedIds = useMemo(() => items.map(item => item.id), [items])

  useEffect(
    () => {
      if (open && !prevOpen) {
        setAddGroups([])
        setRemoveGroups([])
      }
    },
    [open, prevOpen],
  )

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
      storeItems(updated)
      onClose()
    },
    [addGroups, onClose, removeGroups, removeGroupsIds, selectedIds],
  )

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
        <Grid container spacing={2} paddingTop={1}>
          <Grid item xs={12}>
            <Search<GroupItem>
              autoFocus
              label="Add to Groups"
              onClear={handleClearAdd}
              onRemove={handleRemoveAdd}
              onSelect={handleSelectAdd}
              selectedItems={addGroups}
              showIcons
              showSelectedChips
              types={{ group: true }}
            />
          </Grid>

          <Grid item xs={12}>
            <Search<GroupItem>
              label="Remove from Groups"
              onClear={handleClearRemove}
              onRemove={handleRemoveRemove}
              onSelect={handleSelectRemove}
              selectedItems={removeGroups}
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

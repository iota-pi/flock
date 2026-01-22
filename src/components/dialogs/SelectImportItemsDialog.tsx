import {
  Box,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  TextField,
  Typography,
} from '@mui/material'
import { matchSorter } from 'match-sorter'
import { useMemo, useState } from 'react'
import { Item, getItemName } from '../../state/items'
import ItemList from '../ItemList'
import { diffItems } from 'src/utils/diff'

export interface Props {
  open: boolean
  items: Item[]
  existingItems: Map<string, Item>
  initialSelectedIds: Set<string>
  onClose: () => void
  onConfirm: (selectedIds: Set<string>) => void
}

export default function SelectImportItemsDialog({
  open,
  items,
  existingItems,
  initialSelectedIds,
  onClose,
  onConfirm,
}: Props) {
  const [search, setSearch] = useState('')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set(initialSelectedIds))

  const getDescription = (item: Item) => {
    const existing = existingItems.get(item.id)
    if (!existing) {
      return 'Restore deleted item'
    }

    const differences = diffItems(existing, item)
    if (differences.length === 0) return 'No changes detected'
    return `Changes: ${differences.join(', ')}`
  }

  const filteredItems = useMemo(() => {
    if (!search.trim()) return items
    return matchSorter(items, search, { keys: [item => getItemName(item)] })
  }, [items, search])

  const handleToggle = (id: string) => {
    const newSelected = new Set(selectedIds)
    if (newSelected.has(id)) {
      newSelected.delete(id)
    } else {
      newSelected.add(id)
    }
    setSelectedIds(newSelected)
  }

  const handleSelectAll = () => {
    if (selectedIds.size === items.length) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(items.map(i => i.id)))
    }
  }

  const isAllSelected = items.length > 0 && selectedIds.size === items.length
  const isIndeterminate = selectedIds.size > 0 && selectedIds.size < items.length

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>Select Items to Import</DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', height: '60vh' }}>
        <Box mb={2}>
          <TextField
            autoFocus
            fullWidth
            label="Search items"
            variant="outlined"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </Box>

        <Box mb={1}>
          <FormControlLabel
            control={
              <Checkbox
                checked={isAllSelected}
                indeterminate={isIndeterminate}
                onChange={handleSelectAll}
              />
            }
            label={isAllSelected ? "Deselect All" : "Select All"}
          />
          <Typography variant="caption" display="block" color="text.secondary">
            {selectedIds.size} selected of {items.length} ({items.length - selectedIds.size} skipped)
          </Typography>
        </Box>

        <Box
          sx={{
            flexGrow: 1,
            overflow: 'hidden',
            border: '1px solid #ddd',
            borderRadius: 1,
          }}
        >
          <ItemList
            items={filteredItems}
            checkboxes
            checkboxSide="left"
            getChecked={item => selectedIds.has(item.id)}
            getDescription={getDescription}
            onCheck={item => handleToggle(item.id)}
            onClick={item => handleToggle(item.id)}
            showIcons
            fullHeight
            noItemsText="No items found"
          />
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          onClick={() => onConfirm(selectedIds)}
          variant="contained"
          color="primary"
        >
          Confirm Selection
        </Button>
      </DialogActions>
    </Dialog>
  )
}

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  Grid,
} from '@mui/material';
import makeStyles from '@mui/styles/makeStyles';
import { useItems, useVault } from '../../state/selectors';
import { GroupItem, Item } from '../../state/items';
import { usePrevious } from '../../utils';
import ItemSearch from '../ItemSearch';

const useStyles = makeStyles(() => ({
  root: {},
}));

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
  const allItems = useItems();
  const groups = useItems<GroupItem>('group');
  const classes = useStyles();
  const prevOpen = usePrevious(open);
  const vault = useVault();

  const [selected, setSelected] = useState<Item[]>([]);
  const [addGroups, setAddGroups] = useState<GroupItem[]>([]);
  const [removeGroups, setRemoveGroups] = useState<GroupItem[]>([]);

  const addGroupsIds = useMemo(() => addGroups.map(g => g.id), [addGroups]);
  const removeGroupsIds = useMemo(() => removeGroups.map(g => g.id), [removeGroups]);
  const selectedIds = useMemo(() => selected.map(item => item.id), [selected]);

  useEffect(
    () => {
      if (open && !prevOpen) {
        setSelected(items);
        setAddGroups([]);
        setRemoveGroups([]);
      }
    },
    [items, open, prevOpen],
  );

  const handleClear = useCallback(() => setSelected([]), []);
  const handleSelectItem = useCallback(
    (item: Item) => {
      setSelected(s => [...s, item]);
    },
    [],
  );
  const handleRemoveItem = useCallback(
    (item: Item) => {
      setSelected(s => s.filter(i => i.id !== item.id));
    },
    [],
  );
  const handleSelectAdd = useCallback(
    (group: GroupItem) => setAddGroups(g => [...g, group]),
    [],
  );
  const handleSelectRemove = useCallback(
    (group: GroupItem) => setRemoveGroups(g => [...g, group]),
    [],
  );
  const handleDone = useCallback(
    () => {
      const updated: GroupItem[] = [];
      const filteredAddGroups = addGroups.filter(g => !removeGroupsIds.includes(g.id));
      for (const group of filteredAddGroups) {
        updated.push({
          ...group,
          members: [...group.members, ...selectedIds],
        });
      }
      for (const group of removeGroups) {
        updated.push({
          ...group,
          members: group.members.filter(m => !selectedIds.includes(m)),
        });
      }
      vault?.store(updated);
      onClose();
    },
    [addGroups, onClose, removeGroups, removeGroupsIds, selectedIds, vault],
  );

  return (
    <Dialog
      className={classes.root}
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
            <ItemSearch
              autoFocus={items.length === 0}
              items={allItems}
              label="Items"
              onClear={handleClear}
              onRemove={handleRemoveItem}
              onSelect={handleSelectItem}
              selectedIds={selectedIds}
              showIcons
              showSelected
            />
          </Grid>

          <Grid item xs={12}>
            <Divider />
          </Grid>

          <Grid item xs={12}>
            <ItemSearch
              autoFocus={items.length > 0}
              items={groups}
              label="Add to Groups"
              onSelect={handleSelectAdd}
              selectedIds={addGroupsIds}
            />
          </Grid>

          <Grid item xs={12}>
            <ItemSearch
              items={groups}
              label="Remove from Groups"
              onSelect={handleSelectRemove}
              selectedIds={removeGroupsIds}
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
  );
}

export default GroupDialog;

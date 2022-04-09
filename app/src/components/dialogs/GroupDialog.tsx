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
import { useVault } from '../../state/selectors';
import { GroupItem, Item } from '../../state/items';
import { usePrevious } from '../../utils';
import Search from '../Search';

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
  const classes = useStyles();
  const prevOpen = usePrevious(open);
  const vault = useVault();

  const [selected, setSelected] = useState<Item[]>([]);
  const [addGroups, setAddGroups] = useState<GroupItem[]>([]);
  const [removeGroups, setRemoveGroups] = useState<GroupItem[]>([]);

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

  const handleClearItems = useCallback(() => setSelected([]), []);
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
  const handleClearAdd = useCallback(() => setAddGroups([]), []);
  const handleSelectAdd = useCallback(
    (group: GroupItem) => setAddGroups(ag => [...ag, group]),
    [],
  );
  const handleRemoveAdd = useCallback(
    (group: GroupItem) => setAddGroups(ag => ag.filter(g => g.id !== group.id)),
    [],
  );
  const handleClearRemove = useCallback(() => setRemoveGroups([]), []);
  const handleSelectRemove = useCallback(
    (group: GroupItem) => setRemoveGroups(rg => [...rg, group]),
    [],
  );
  const handleRemoveRemove = useCallback(
    (group: GroupItem) => setRemoveGroups(rg => rg.filter(g => g.id !== group.id)),
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
        <Grid container spacing={2} paddingTop={1}>
          <Grid item xs={12}>
            <Search<Item>
              autoFocus={items.length === 0}
              label="Items"
              onClear={handleClearItems}
              onRemove={handleRemoveItem}
              onSelect={handleSelectItem}
              selectedItems={selected}
              showIcons
              showSelectedTags
              types={{ person: true, group: true, general: true }}
            />
          </Grid>

          <Grid item xs={12}>
            <Divider />
          </Grid>

          <Grid item xs={12}>
            <Search<GroupItem>
              autoFocus={items.length > 0}
              label="Add to Groups"
              onClear={handleClearAdd}
              onRemove={handleRemoveAdd}
              onSelect={handleSelectAdd}
              selectedItems={addGroups}
              showIcons
              showSelectedTags
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
              showSelectedTags
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
  );
}

export default GroupDialog;

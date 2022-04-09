import { useCallback, useEffect, useState } from 'react';
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
import { Item } from '../../state/items';
import { usePrevious } from '../../utils';
import TagSelection from '../TagSelection';
import { AddIcon, MinusIcon } from '../Icons';
import Search from '../Search';

const useStyles = makeStyles(() => ({
  root: {},
}));

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
  const classes = useStyles();
  const prevOpen = usePrevious(open);
  const vault = useVault();

  const [selected, setSelected] = useState<Item[]>([]);
  const [addTags, setAddTags] = useState<string[]>([]);
  const [removeTags, setRemoveTags] = useState<string[]>([]);

  useEffect(
    () => {
      if (open && !prevOpen) {
        setSelected(items);
        setAddTags([]);
        setRemoveTags([]);
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
  const handleChangeAdd = useCallback((tags: string[]) => setAddTags(tags), []);
  const handleChangeRemove = useCallback((tags: string[]) => setRemoveTags(tags), []);
  const handleDone = useCallback(
    () => {
      const updated: Item[] = [];
      for (const item of selected) {
        const remainingTags = item.tags.filter(tag => !removeTags.includes(tag));
        const newTags = addTags.filter(tag => !item.tags.includes(tag));
        if (remainingTags.length < item.tags.length || newTags.length > 0) {
          const newItem: Item = {
            ...item,
            tags: [...remainingTags, ...newTags],
          };
          updated.push(newItem);
        }
      }
      vault?.store(updated);
      onClose();
    },
    [addTags, onClose, removeTags, selected, vault],
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
            <Search<Item>
              autoFocus={items.length === 0}
              label="Items"
              onClear={handleClear}
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
  );
}

export default TagDialog;

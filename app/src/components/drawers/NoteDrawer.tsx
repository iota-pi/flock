import React, {
  ChangeEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';
import {
  Checkbox,
  FormControlLabel,
  Grid,
  IconButton,
  InputAdornment,
  TextField,
} from '@material-ui/core';
import Visibility from '@material-ui/icons/Visibility';
import VisibilityOff from '@material-ui/icons/VisibilityOff';
import { KeyboardDatePicker } from '@material-ui/pickers';
import {
  compareItems,
  getItemById,
  Item,
  ItemNote,
  lookupItemsById,
  updateItems,
} from '../../state/items';
import { useItems, useNoteMap, useVault } from '../../state/selectors';
import BaseDrawer, { BaseDrawerProps } from './BaseDrawer';
import ItemSearch from '../ItemSearch';
import { useAppDispatch } from '../../store';
import ItemList from '../ItemList';
import { RemoveIcon } from '../Icons';
import { getItemId, usePrevious } from '../../utils';

export interface Props extends BaseDrawerProps {
  note: ItemNote,
  linkedItems?: Item[],
  onChange: (note: ItemNote) => void,
}

function NoteDrawer({
  alwaysTemporary,
  linkedItems: linkedItemsProp,
  note,
  onBack,
  onClose,
  onChange,
  onExited,
  open,
  stacked,
}: Props) {
  const dispatch = useAppDispatch();
  const vault = useVault();
  const allItems = useItems();
  const noteMap = useNoteMap();
  const prevNote = usePrevious(note);

  const [linkedItems, setLinkedItems] = useState<Item[]>([]);
  const [showSensitive, setShowSensitive] = useState(false);

  const existingLinkedItem = useMemo(
    () => getItemById(allItems, noteMap[note.id]),
    [allItems, note.id, noteMap],
  );
  const editing = existingLinkedItem !== undefined;
  const autoFocusSearch = !editing && linkedItemsProp === undefined;
  const items = useMemo(
    () => (
      allItems.filter(item => {
        if (note.type === 'interaction') {
          return item.type === 'person' || (!editing && item.type === 'group');
        }
        return true;
      }).sort(compareItems)
    ),
    [allItems, editing, note.type],
  );

  useEffect(
    () => {
      if (open) {
        if (linkedItemsProp) {
          setLinkedItems(linkedItemsProp);
        } else {
          setLinkedItems(existingLinkedItem ? [existingLinkedItem] : []);
        }
        setShowSensitive(false);
      }
    },
    [existingLinkedItem, linkedItemsProp, open],
  );

  const handleClear = useCallback(() => setLinkedItems([]), []);
  const handleChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const value = event.target.value;
      onChange({ ...note, content: value });
    },
    [note, onChange],
  );
  const handleAddItem = useCallback(
    (item: Item) => {
      const newItems = item.type === 'group' ? lookupItemsById(items, item.members) : [item];

      if (editing) {
        setLinkedItems(newItems);
      } else {
        setLinkedItems(prev => {
          const uniqueNewItems = newItems.filter(i1 => !prev.find(i2 => i1.id === i2.id));
          return [...prev, ...uniqueNewItems];
        });
      }
    },
    [editing, items],
  );
  const handleRemoveItem = useCallback(
    (item: Item) => {
      setLinkedItems(linked => linked.filter(i => i.id !== item.id));
    },
    [],
  );
  const handleUnlinkItem = useCallback(
    (item: Item) => () => {
      setLinkedItems(prev => prev.filter(i => i.id !== item.id));
    },
    [],
  );
  const handleChangeSensitive = useCallback(
    () => onChange({ ...note, sensitive: !note.sensitive }),
    [note, onChange],
  );
  const handleDateChange = useCallback(
    (date: Date | null) => onChange({ ...note, date: (date || new Date()).getTime() }),
    [note, onChange],
  );

  const handleClickVisibility = useCallback(() => setShowSensitive(show => !show), []);
  const handleMouseDownVisibility = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => event.preventDefault(),
    [],
  );

  const handleSave = useCallback(
    async (noteToSave: ItemNote) => {
      let newNote: ItemNote = {
        ...noteToSave,
        content: noteToSave.content.trim(),
      };
      const itemsToUpdate: Item[] = [];
      for (const linkedItem of linkedItems) {
        if (editing) {
          const oldItem = getItemById(items, noteMap[noteToSave.id]);
          if (oldItem && oldItem.id !== linkedItem.id) {
            itemsToUpdate.push({
              ...oldItem,
              notes: oldItem.notes.filter(n => n.id !== noteToSave.id),
            });
          }
        }

        itemsToUpdate.push({
          ...linkedItem,
          notes: [
            ...linkedItem.notes.filter(n => n.id !== noteToSave.id),
            newNote,
          ],
        });

        // Update note id between each linked item
        newNote = { ...newNote, id: getItemId() };
      }
      vault?.store(itemsToUpdate);
      dispatch(updateItems(itemsToUpdate));
    },
    [dispatch, editing, items, linkedItems, noteMap, vault],
  );
  const handleSaveAndClose = useCallback(
    () => {
      handleSave(note);
      onClose();
    },
    [handleSave, note, onClose],
  );
  const handleCancel = useCallback(
    () => {
      onClose();
    },
    [onClose],
  );
  const handleDelete = useCallback(
    () => {
      if (note) {
        const oldItem = getItemById(items, noteMap[note.id]);
        if (oldItem) {
          const newItem: Item = {
            ...oldItem,
            notes: oldItem.notes.filter(n => n.id !== note.id),
          };
          vault?.store(newItem);
          dispatch(updateItems([newItem]));
        }
      }
      onClose();
    },
    [dispatch, items, noteMap, onClose, note, vault],
  );

  const isVisible = useMemo(
    () => !note.sensitive || showSensitive,
    [note, showSensitive],
  );

  useEffect(
    () => {
      if (open && prevNote && prevNote.id !== note.id) {
        handleSave(prevNote);
      }
    },
    [handleSave, note.id, open, prevNote],
  );

  const itemsLabel = note.type === 'interaction' ? 'People' : 'Items';
  const contentLabel = note.type === 'interaction' ? 'Comment' : 'Prayer Point';

  return (
    <BaseDrawer
      ActionProps={{
        canSave: linkedItems.length > 0,
        editing,
        itemIsNote: true,
        itemName: note?.type,
        onCancel: handleCancel,
        onDelete: handleDelete,
        onSave: handleSaveAndClose,
      }}
      alwaysTemporary={alwaysTemporary}
      onBack={onBack}
      onClose={handleSaveAndClose}
      onExited={onExited}
      open={open}
      stacked={stacked}
    >
      <Grid container spacing={2}>
        <Grid item xs={12}>
          <ItemSearch
            autoFocus={autoFocusSearch}
            items={items}
            key={note.id}
            label={itemsLabel}
            noItemsText={`No ${itemsLabel.toLowerCase()} found`}
            onClear={handleClear}
            onRemove={handleRemoveItem}
            onSelect={handleAddItem}
            selectedIds={linkedItems.map(item => item.id)}
            showGroupMemberCount
            showIcons
            showSelected={editing}
          />

          {!editing && (
            <ItemList
              actionIcon={<RemoveIcon />}
              dividers
              items={linkedItems}
              noItemsHint={`No ${itemsLabel.toLowerCase()} selected`}
              onClickAction={handleUnlinkItem}
            />
          )}
        </Grid>

        <Grid item xs={12}>
          <TextField
            autoFocus={!autoFocusSearch}
            disabled={!isVisible}
            fullWidth
            key={note.id}
            label={contentLabel}
            multiline={note.content.length > 30}
            onChange={handleChange}
            value={!isVisible ? '...' : note.content}
            InputProps={{
              endAdornment: note.sensitive ? (
                <InputAdornment position="end">
                  <IconButton
                    onClick={handleClickVisibility}
                    onMouseDown={handleMouseDownVisibility}
                  >
                    {showSensitive ? <Visibility /> : <VisibilityOff />}
                  </IconButton>
                </InputAdornment>
              ) : null,
            }}
          />

          <FormControlLabel
            control={(
              <Checkbox
                checked={note.sensitive || false}
                onChange={handleChangeSensitive}
              />
            )}
            label="Sensitive"
          />
        </Grid>

        {note.type === 'interaction' && (
          <Grid item xs={12}>
            <KeyboardDatePicker
              value={new Date(note.date)}
              onChange={handleDateChange}
              label="Interaction Date"
              maxDate={new Date()}
              maxDateMessage="Only past interactions can be recorded in the present"
              format="dd/MM/yyyy"
            />
          </Grid>
        )}
      </Grid>
    </BaseDrawer>
  );
}

export default NoteDrawer;

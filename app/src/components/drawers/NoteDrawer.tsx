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
  onChange: (note: ItemNote) => void,
}

function NoteDrawer({
  alwaysTemporary,
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
  const items = useMemo(
    () => (
      allItems.filter(
        item => item.type === 'person' || (!editing && item.type === 'group'),
      ).sort(compareItems)
    ),
    [allItems, editing],
  );

  useEffect(
    () => {
      if (open) {
        setLinkedItems(existingLinkedItem ? [existingLinkedItem] : []);
        setShowSensitive(false);
      }
    },
    [existingLinkedItem, open],
  );

  const handleChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const value = event.target.value;
      onChange({ ...note, content: value });
    },
    [note, onChange],
  );
  const handleAddItem = useCallback(
    (item?: Item) => {
      if (item) {
        const newItems = item.type === 'group' ? lookupItemsById(items, item.members) : [item];

        if (editing) {
          setLinkedItems(newItems);
        } else {
          setLinkedItems(prev => {
            const uniqueNewItems = newItems.filter(i1 => !prev.find(i2 => i1.id === i2.id));
            return [...prev, ...uniqueNewItems];
          });
        }
      }
    },
    [editing, items],
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
      for (const item of itemsToUpdate) {
        vault?.store(item);
      }
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
  const handleUnmount = useCallback(() => handleSave(note), [handleSave, note]);
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
      onUnmount={handleUnmount}
      open={open}
      stacked={stacked}
    >
      <Grid container spacing={2}>
        <Grid item xs={12}>
          <ItemSearch
            autoFocus
            items={items}
            label="People"
            noItemsText="No people found"
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
              noItemsHint="No people selected"
              onClickAction={handleUnlinkItem}
            />
          )}
        </Grid>

        <Grid item xs={12}>
          <TextField
            disabled={!isVisible}
            fullWidth
            label="Comment"
            multiline
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
      </Grid>
    </BaseDrawer>
  );
}

export default NoteDrawer;

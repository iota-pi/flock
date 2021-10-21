import {
  ChangeEvent,
  MouseEvent,
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
import { DatePicker } from '@material-ui/lab';
import { Item, ItemNote } from '../../state/items';
import { useItemMap, useItems, useItemsById, useMetadata, useNoteMap, useVault } from '../../state/selectors';
import BaseDrawer, { BaseDrawerProps } from './BaseDrawer';
import ItemSearch from '../ItemSearch';
import ItemList from '../ItemList';
import { RemoveIcon } from '../Icons';
import { getItemId, usePrevious } from '../../utils';
import { DEFAULT_CRITERIA, sortItems } from '../../utils/customSort';
import { DEFAULT_MATURITY } from '../../state/account';

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
  const allItems = useItems();
  const getItemsById = useItemsById();
  const itemMap = useItemMap();
  const [maturity] = useMetadata('maturity', DEFAULT_MATURITY);
  const noteMap = useNoteMap();
  const prevNote = usePrevious(note);
  const [sortCriteria] = useMetadata('sortCriteria', DEFAULT_CRITERIA);
  const vault = useVault();

  const [linkedItems, setLinkedItems] = useState<Item[]>([]);
  const [showSensitive, setShowSensitive] = useState(false);

  const existingLinkedItem = useMemo(
    () => itemMap[noteMap[note.id]] as Item | undefined,
    [itemMap, note.id, noteMap],
  );
  const editing = existingLinkedItem !== undefined;
  const autoFocusSearch = !editing && linkedItemsProp === undefined;
  const items = useMemo(
    () => (
      sortItems(
        allItems.filter(item => {
          if (note.type === 'interaction') {
            return item.type === 'person' || (!editing && item.type === 'group');
          }
          return true;
        }),
        sortCriteria,
        maturity,
      )
    ),
    [allItems, editing, maturity, note.type, sortCriteria],
  );

  useEffect(
    () => {
      if (open && note.id !== prevNote?.id) {
        if (existingLinkedItem) {
          setLinkedItems([existingLinkedItem]);
        } else {
          setLinkedItems(linkedItemsProp || []);
        }
        setShowSensitive(false);
      }
    },
    [existingLinkedItem, linkedItemsProp, note.id, open, prevNote?.id],
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
      const newItems = item.type === 'group' ? getItemsById(item.members) : [item];

      if (editing) {
        setLinkedItems(newItems);
      } else {
        setLinkedItems(prev => {
          const uniqueNewItems = newItems.filter(i1 => !prev.find(i2 => i1.id === i2.id));
          return [...prev, ...uniqueNewItems];
        });
      }
    },
    [editing, getItemsById],
  );
  const handleUnlinkItem = useCallback(
    (item: Item) => {
      setLinkedItems(linked => linked.filter(i => i.id !== item.id));
    },
    [],
  );
  const handleChangeSensitive = useCallback(
    () => onChange({ ...note, sensitive: !note.sensitive }),
    [note, onChange],
  );
  const handleChangeCompleted = useCallback(
    () => note.type === 'action' && onChange({
      ...note,
      completed: note.completed ? undefined : new Date().getTime(),
    }),
    [note, onChange],
  );
  const handleDateChange = useCallback(
    (date: Date | null) => onChange({ ...note, date: (date || new Date()).getTime() }),
    [note, onChange],
  );

  const handleClickVisibility = useCallback(() => setShowSensitive(show => !show), []);
  const handleMouseDownVisibility = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => event.preventDefault(),
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
          const oldItem: Item | undefined = itemMap[noteMap[noteToSave.id]];
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
    },
    [editing, itemMap, linkedItems, noteMap, vault],
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
        const oldItem: Item | undefined = itemMap[noteMap[note.id]];
        if (oldItem) {
          const newItem: Item = {
            ...oldItem,
            notes: oldItem.notes.filter(n => n.id !== note.id),
          };
          vault?.store(newItem);
        }
      }
      onClose();
    },
    [itemMap, noteMap, onClose, note, vault],
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
  const contentLabel = note.type !== 'prayer' ? 'Comment' : 'Prayer Point';

  return (
    <BaseDrawer
      ActionProps={{
        canSave: linkedItems.length > 0,
        itemIsNew: !editing,
        itemIsNote: true,
        itemName: note.type,
        onCancel: handleCancel,
        onDelete: handleDelete,
        onSave: handleSaveAndClose,
      }}
      alwaysTemporary={alwaysTemporary}
      itemKey={note.id}
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
            onRemove={handleUnlinkItem}
            onSelect={handleAddItem}
            selectedIds={linkedItems.map(item => item.id)}
            showGroupMemberCount
            showIcons
            showSelected={editing}
          />

          {!editing && (
            <ItemList
              dividers
              getActionIcon={() => <RemoveIcon />}
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
                    size="large"
                  >
                    {showSensitive ? <Visibility /> : <VisibilityOff />}
                  </IconButton>
                </InputAdornment>
              ) : null,
            }}
            variant="standard"
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
            <DatePicker<Date | null>
              inputFormat="dd/MM/yyyy"
              label="Interaction Date"
              maxDate={new Date()}
              onChange={handleDateChange}
              renderInput={params => <TextField {...params} variant="standard" />}
              value={new Date(note.date)}
            />
          </Grid>
        )}

        {note.type === 'action' && (
          <>
            <Grid item xs={12}>
              <DatePicker<Date | null>
                inputFormat="dd/MM/yyyy"
                label="Action Due Date"
                onChange={handleDateChange}
                renderInput={params => <TextField {...params} variant="standard" />}
                value={new Date(note.date)}
              />
            </Grid>

            <Grid item xs={12}>
              <FormControlLabel
                control={(
                  <Checkbox
                    checked={!!note.completed}
                    onChange={handleChangeCompleted}
                  />
                )}
                label="Completed"
              />
            </Grid>
          </>
        )}
      </Grid>
    </BaseDrawer>
  );
}

export default NoteDrawer;

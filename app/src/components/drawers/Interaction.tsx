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
  getBlankNote,
  getItemById,
  Item,
  ItemNote,
  lookupItemsById,
  updateItems,
} from '../../state/items';
import { useItems, useNoteMap, useVault } from '../../state/selectors';
import BaseDrawer, { ItemDrawerProps } from './BaseDrawer';
import ItemSearch from '../ItemSearch';
import { useAppDispatch } from '../../store';
import ItemList from '../ItemList';
import { RemoveIcon } from '../Icons';
import { getItemId } from '../../utils';

export interface Props extends ItemDrawerProps {
  interaction: ItemNote<'interaction'> | undefined,
}


function InteractionDrawer({
  interaction: rawInteraction,
  onBack,
  onClose,
  open,
  stacked,
}: Props) {
  const dispatch = useAppDispatch();
  const vault = useVault();
  const allItems = useItems();
  const noteMap = useNoteMap();

  const isEditing = !!rawInteraction;
  const [interaction, setInteraction] = useState(rawInteraction || getBlankNote('interaction'));
  const [linkedItems, setLinkedItems] = useState<Item[]>([]);
  const [showSensitive, setShowSensitive] = useState(false);

  const items = useMemo(
    () => (
      allItems.filter(
        item => item.type === 'person' || (!isEditing && item.type === 'group'),
      ).sort(compareItems)
    ),
    [allItems, isEditing],
  );

  useEffect(
    () => {
      if (rawInteraction) {
        setInteraction(rawInteraction);
        const existingLinkedItem = getItemById(items, noteMap[rawInteraction.id]);
        setLinkedItems(existingLinkedItem ? [existingLinkedItem] : []);
        setShowSensitive(false);
      } else {
        setInteraction(getBlankNote('interaction'));
        setLinkedItems([]);
        setShowSensitive(false);
      }
    },
    [items, noteMap, rawInteraction],
  );

  const handleChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const value = event.target.value;
      setInteraction({ ...interaction, content: value });
    },
    [interaction],
  );
  const handleAddItem = useCallback(
    (item?: Item) => {
      if (item) {
        const newItems = item.type === 'group' ? lookupItemsById(items, item.members) : [item];

        if (isEditing) {
          setLinkedItems(newItems);
        } else {
          setLinkedItems(prev => {
            const uniqueNewItems = newItems.filter(i1 => !prev.find(i2 => i1.id === i2.id));
            return [...prev, ...uniqueNewItems];
          });
        }
      }
    },
    [isEditing, items],
  );
  const handleUnlinkItem = useCallback(
    (item: Item) => () => {
      setLinkedItems(prev => prev.filter(i => i.id !== item.id));
    },
    [],
  );
  const handleChangeSensitive = useCallback(
    () => setInteraction({ ...interaction, sensitive: !interaction.sensitive }),
    [interaction],
  );
  const handleDateChange = useCallback(
    (date: Date | null) => setInteraction({ ...interaction, date: (date || new Date()).getTime() }),
    [interaction],
  );

  const handleClickVisibility = useCallback(() => setShowSensitive(show => !show), []);
  const handleMouseDownVisibility = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => event.preventDefault(),
    [],
  );

  const handleSave = useCallback(
    async () => {
      let newNote: ItemNote<'interaction'> = {
        ...interaction,
        content: interaction.content.trim(),
      };
      const itemsToUpdate: Item[] = [];
      for (const linkedItem of linkedItems) {
        if (isEditing) {
          const oldItem = getItemById(items, noteMap[interaction.id]);
          if (oldItem && oldItem.id !== linkedItem.id) {
            itemsToUpdate.push({
              ...oldItem,
              notes: oldItem.notes.filter(note => note.id !== interaction.id),
            });
          }
        }

        itemsToUpdate.push({
          ...linkedItem,
          notes: [
            ...linkedItem.notes.filter(note => note.id !== interaction.id),
            newNote,
          ],
        });

        // Update interaction id between each linked item
        newNote = { ...newNote, id: getItemId() };
      }
      for (const item of itemsToUpdate) {
        vault?.store(item);
      }
      dispatch(updateItems(itemsToUpdate));
      setInteraction(getBlankNote('interaction'));
      onClose();
    },
    [dispatch, interaction, isEditing, items, linkedItems, noteMap, onClose, vault],
  );
  const handleCancel = useCallback(
    () => {
      setInteraction(getBlankNote('interaction'));
      onClose();
    },
    [onClose],
  );
  const handleDelete = useCallback(
    () => {
      if (rawInteraction) {
        const oldItem = getItemById(items, noteMap[rawInteraction.id]);
        if (oldItem) {
          const newItem: Item = {
            ...oldItem,
            notes: oldItem.notes.filter(note => note.id !== rawInteraction.id),
          };
          vault?.store(newItem);
          dispatch(updateItems([newItem]));
        }
      }
      setInteraction(getBlankNote('interaction'));
      onClose();
    },
    [dispatch, items, noteMap, onClose, rawInteraction, vault],
  );

  const isVisible = useMemo(
    () => !interaction.sensitive || showSensitive,
    [interaction, showSensitive],
  );

  return (
    <BaseDrawer
      ActionProps={{
        canSave: linkedItems.length > 0,
        editing: !!rawInteraction,
        itemIsNote: true,
        itemName: rawInteraction?.type,
        onCancel: handleCancel,
        onDelete: handleDelete,
        onSave: handleSave,
      }}
      open={open}
      onBack={onBack}
      onClose={handleSave}
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
            showSelected={isEditing}
          />

          {!isEditing && (
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
            value={!isVisible ? '...' : interaction.content}
            InputProps={{
              endAdornment: interaction.sensitive ? (
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
                checked={interaction.sensitive || false}
                onChange={handleChangeSensitive}
              />
            )}
            label="Sensitive"
          />
        </Grid>

        <Grid item xs={12}>
          <KeyboardDatePicker
            value={new Date(interaction.date)}
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

export default InteractionDrawer;

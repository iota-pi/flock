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
  getBlankNote,
  getItemById,
  Item,
  ItemNote,
  updateItems,
} from '../../state/items';
import { useItems, useNoteMap, useVault } from '../../state/selectors';
import BaseDrawer, { ItemDrawerProps } from './BaseDrawer';
import ItemSearch from '../ItemSearch';
import { useAppDispatch } from '../../store';
import DrawerActions from './utils/DrawerActions';

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
  const items = useItems();
  const noteMap = useNoteMap();

  const [interaction, setInteraction] = useState(rawInteraction || getBlankNote('interaction'));
  const [linkedItem, setLinkedItem] = useState<Item>();
  const [showSensitive, setShowSensitive] = useState(false);

  useEffect(
    () => {
      if (rawInteraction) {
        setInteraction(rawInteraction);
        const existingLinkedItem = getItemById(items, noteMap[rawInteraction.id]);
        setLinkedItem(existingLinkedItem);
        setShowSensitive(false);
      } else {
        setInteraction(getBlankNote('interaction'));
        setLinkedItem(undefined);
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
  const handleChangePerson = useCallback(
    (item?: Item) => {
      setLinkedItem(item);
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
      const newNote: ItemNote<'interaction'> = {
        ...interaction,
        content: interaction.content.trim(),
      };
      if (newNote.content && linkedItem) {
        const itemsToUpdate: Item[] = [];
        const oldItem = getItemById(items, noteMap[interaction.id]);
        if (oldItem && oldItem.id !== linkedItem.id) {
          itemsToUpdate.push({
            ...oldItem,
            notes: oldItem.notes.filter(note => note.id !== interaction.id),
          });
        }

        itemsToUpdate.push({
          ...linkedItem,
          notes: [
            ...linkedItem.notes.filter(note => note.id !== interaction.id),
            newNote,
          ],
        });

        for (const item of itemsToUpdate) {
          vault?.store(item);
        }
        dispatch(updateItems(itemsToUpdate));
        setInteraction(getBlankNote('interaction'));
      }
      onClose();
    },
    [dispatch, interaction, items, linkedItem, noteMap, onClose, vault],
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
    <>
      <BaseDrawer
        open={open}
        onBack={onBack}
        onClose={handleSave}
        stacked={stacked}
      >
        <Grid container spacing={2}>
          <Grid item xs={12}>
            <ItemSearch
              selectedIds={linkedItem ? [linkedItem.id] : []}
              items={items}
              label="Object of Interaction"
              noItemsText="No people found"
              onSelect={handleChangePerson}
            />
          </Grid>

          <Grid item xs={12}>
            <TextField
              value={!isVisible ? '...' : interaction.content}
              onChange={handleChange}
              disabled={!isVisible}
              label="Interaction details"
              multiline
              fullWidth
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

        <DrawerActions
          canSave={!!interaction.content}
          item={rawInteraction}
          onCancel={handleCancel}
          onDelete={handleDelete}
          onSave={handleSave}
        />
      </BaseDrawer>
    </>
  );
}

export default InteractionDrawer;

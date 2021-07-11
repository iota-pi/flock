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
import {
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
  prayerPoint: ItemNote<'prayer'> | undefined,
}


function PrayerPointDrawer({
  prayerPoint: rawPrayerPoint,
  onBack,
  onClose,
  open,
  stacked,
}: Props) {
  const dispatch = useAppDispatch();
  const vault = useVault();
  const items = useItems();
  const noteMap = useNoteMap();

  const isEditing = !!rawPrayerPoint;
  const [prayerPoint, setPrayerPoint] = useState(rawPrayerPoint || getBlankNote('prayer'));
  const [linkedItems, setLinkedItems] = useState<Item[]>([]);
  const [showSensitive, setShowSensitive] = useState(false);

  useEffect(
    () => {
      if (rawPrayerPoint) {
        setPrayerPoint(rawPrayerPoint);
        const existingLinkedItem = getItemById(items, noteMap[rawPrayerPoint.id]);
        setLinkedItems(existingLinkedItem ? [existingLinkedItem] : []);
        setShowSensitive(false);
      } else {
        setPrayerPoint(getBlankNote('prayer'));
        setLinkedItems([]);
        setShowSensitive(false);
      }
    },
    [items, noteMap, rawPrayerPoint],
  );

  const handleChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const value = event.target.value;
      setPrayerPoint({ ...prayerPoint, content: value });
    },
    [prayerPoint],
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
    () => setPrayerPoint({ ...prayerPoint, sensitive: !prayerPoint.sensitive }),
    [prayerPoint],
  );

  const handleClickVisibility = useCallback(() => setShowSensitive(show => !show), []);
  const handleMouseDownVisibility = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => event.preventDefault(),
    [],
  );

  const handleSave = useCallback(
    async () => {
      let newNote: ItemNote<'prayer'> = {
        ...prayerPoint,
        content: prayerPoint.content.trim(),
      };
      const itemsToUpdate: Item[] = [];
      for (const linkedItem of linkedItems) {
        if (isEditing) {
          const oldItem = getItemById(items, noteMap[prayerPoint.id]);
          if (oldItem && oldItem.id !== linkedItem.id) {
            itemsToUpdate.push({
              ...oldItem,
              notes: oldItem.notes.filter(note => note.id !== prayerPoint.id),
            });
          }
        }

        itemsToUpdate.push({
          ...linkedItem,
          notes: [
            ...linkedItem.notes.filter(note => note.id !== prayerPoint.id),
            newNote,
          ],
        });

        // Update prayer point id between each linked item
        newNote = { ...newNote, id: getItemId() };
      }
      for (const item of itemsToUpdate) {
        vault?.store(item);
      }
      dispatch(updateItems(itemsToUpdate));
      setPrayerPoint(getBlankNote('prayer'));
      onClose();
    },
    [dispatch, prayerPoint, isEditing, items, linkedItems, noteMap, onClose, vault],
  );
  const handleCancel = useCallback(
    () => {
      setPrayerPoint(getBlankNote('prayer'));
      onClose();
    },
    [onClose],
  );
  const handleDelete = useCallback(
    () => {
      if (rawPrayerPoint) {
        const oldItem = getItemById(items, noteMap[rawPrayerPoint.id]);
        if (oldItem) {
          const newItem: Item = {
            ...oldItem,
            notes: oldItem.notes.filter(note => note.id !== rawPrayerPoint.id),
          };
          vault?.store(newItem);
          dispatch(updateItems([newItem]));
        }
      }
      setPrayerPoint(getBlankNote('prayer'));
      onClose();
    },
    [dispatch, items, noteMap, onClose, rawPrayerPoint, vault],
  );

  const isVisible = useMemo(
    () => !prayerPoint.sensitive || showSensitive,
    [prayerPoint, showSensitive],
  );

  return (
    <BaseDrawer
      ActionProps={{
        canSave: linkedItems.length > 0,
        editing: !!rawPrayerPoint,
        itemIsNote: true,
        itemName: rawPrayerPoint?.type,
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
            label="Items"
            noItemsText="No items found"
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
              noItemsHint="No items selected"
              onClickAction={handleUnlinkItem}
            />
          )}
        </Grid>

        <Grid item xs={12}>
          <TextField
            disabled={!isVisible}
            fullWidth
            label="Prayer point"
            multiline
            onChange={handleChange}
            value={!isVisible ? '...' : prayerPoint.content}
            InputProps={{
              endAdornment: prayerPoint.sensitive ? (
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
                checked={prayerPoint.sensitive || false}
                onChange={handleChangeSensitive}
              />
            )}
            label="Sensitive"
          />
        </Grid>
      </Grid>
    </BaseDrawer>
  );
}

export default PrayerPointDrawer;

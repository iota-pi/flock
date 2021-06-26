import React, {
  ChangeEvent,
  useCallback,
  useEffect,
  useState,
} from 'react';
import {
  Grid,
  TextField,
  Typography,
} from '@material-ui/core';
import {
  deleteItems,
  GeneralItem,
  getBlankGeneral,
  ItemNote,
  updateItems,
} from '../../state/items';
import { useAppDispatch } from '../../store';
import NoteDisplay from '../NoteDisplay';
import { useVault } from '../../state/selectors';
import BaseDrawer, { ItemDrawerProps } from './BaseDrawer';
import DrawerActions from './utils/DrawerActions';
import { Frequency } from '../../utils/frequencies';
import FrequencyControls from '../FrequencyControls';

export interface Props extends ItemDrawerProps {
  item: GeneralItem | undefined,
}


function GeneralDrawer({
  item,
  onClose,
  open,
  stacked,
}: Props) {
  const dispatch = useAppDispatch();
  const vault = useVault();

  const [localItem, setLocalItem] = useState(getBlankGeneral());

  const valid = !!localItem.name;

  useEffect(
    () => {
      if (item) {
        setLocalItem({ ...item });
      } else {
        setLocalItem(getBlankGeneral());
      }
    },
    [item],
  );

  const handleChange = useCallback(
    (key: keyof GeneralItem) => (
      (e: ChangeEvent<HTMLInputElement>) => {
        const value = e.target.value;
        setLocalItem({ ...localItem, [key]: value });
      }
    ),
    [localItem],
  );
  const handleChangeFrequency = useCallback(
    (key: 'interactionFrequency' | 'prayerFrequency') => (
      (value: Frequency) => {
        setLocalItem({ ...localItem, [key as string]: value });
      }
    ),
    [localItem],
  );
  const handleChangeNotes = useCallback(
    (newNotes: ItemNote[]) => setLocalItem({ ...localItem, notes: newNotes }),
    [localItem],
  );
  const handleSave = useCallback(
    async () => {
      localItem.name = localItem.name.trim();
      if (valid) {
        vault?.store(localItem);
        dispatch(updateItems([localItem]));
        setLocalItem(getBlankGeneral());
      }
      onClose();
    },
    [dispatch, localItem, onClose, valid, vault],
  );
  const handleCancel = useCallback(
    () => {
      setLocalItem(getBlankGeneral());
      onClose();
    },
    [onClose],
  );
  const handleDelete = useCallback(
    () => {
      vault?.delete(localItem.id);
      dispatch(deleteItems([localItem]));
      setLocalItem(getBlankGeneral());
      onClose();
    },
    [dispatch, onClose, localItem, vault],
  );

  return (
    <>
      <BaseDrawer
        open={open}
        onClose={handleSave}
        stacked={stacked}
      >
        <Grid container spacing={2}>
          <Grid item xs={12}>
            <Typography variant="h5">
              Basic details
            </Typography>
          </Grid>

          <Grid item xs={12}>
            <TextField
              value={localItem.name}
              onChange={handleChange('name')}
              label="Item Name"
              required
              fullWidth
            />
          </Grid>

          <Grid item xs={12}>
            <TextField
              value={localItem.description}
              onChange={handleChange('description')}
              label="Description"
              multiline
              fullWidth
            />
          </Grid>

          <Grid item />
          <Grid item xs={12}>
            <Typography variant="h5">
              Desired frequencies
            </Typography>
          </Grid>

          <FrequencyControls
            item={localItem}
            onChange={handleChangeFrequency}
          />

          <Grid item />
          <Grid item xs={12}>
            <Typography variant="h5">
              Notes
            </Typography>
          </Grid>

          <Grid item xs={12}>
            <NoteDisplay
              notes={localItem.notes}
              onChange={handleChangeNotes}
            />
          </Grid>
        </Grid>

        <DrawerActions
          canSave={valid}
          item={item}
          onCancel={handleCancel}
          onDelete={handleDelete}
          onSave={handleSave}
        />
      </BaseDrawer>
    </>
  );
}

export default GeneralDrawer;

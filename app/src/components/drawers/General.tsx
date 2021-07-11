import React, {
  ChangeEvent,
  useCallback,
  useEffect,
  useState,
} from 'react';
import {
  Checkbox,
  FormControlLabel,
  Grid,
  TextField,
  Typography,
} from '@material-ui/core';
import {
  deleteItems,
  GeneralItem,
  getBlankGeneral,
  getItemName,
  ItemNote,
  updateItems,
} from '../../state/items';
import { useAppDispatch } from '../../store';
import NoteControl from '../NoteControl';
import { useVault } from '../../state/selectors';
import BaseDrawer, { ItemDrawerProps } from './BaseDrawer';
import { Frequency } from '../../utils/frequencies';
import FrequencyControls from '../FrequencyControls';
import TagSelection from '../TagSelection';

export interface Props extends ItemDrawerProps {
  item: GeneralItem | undefined,
}


function GeneralDrawer({
  item,
  onBack,
  onClose,
  open,
  stacked,
}: Props) {
  const dispatch = useAppDispatch();
  const vault = useVault();

  const [localItem, setLocalItem] = useState(item || getBlankGeneral());

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
        setLocalItem(i => ({ ...i, [key]: value }));
      }
    ),
    [],
  );
  const handleChangeBoolean = useCallback(
    (key: keyof GeneralItem) => (
      (event: ChangeEvent<HTMLInputElement>, checked: boolean) => {
        setLocalItem(i => ({ ...i, [key]: checked }));
      }
    ),
    [],
  );
  const handleChangeFrequency = useCallback(
    (key: 'interactionFrequency' | 'prayerFrequency') => (
      (value: Frequency) => {
        setLocalItem(i => ({ ...i, [key as string]: value }));
      }
    ),
    [],
  );
  const handleChangeNotes = useCallback(
    (newNotes: ItemNote[]) => setLocalItem(i => ({ ...i, notes: newNotes })),
    [],
  );
  const handleChangeTags = useCallback(
    (newTags: string[]) => setLocalItem(i => ({ ...i, tags: newTags })),
    [],
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
        ActionProps={{
          canSave: valid,
          editing: !!item,
          itemName: item ? getItemName(item) : undefined,
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
              fullWidth
            />
          </Grid>

          <Grid item xs={12}>
            <TextField
              value={localItem.summary}
              onChange={handleChange('summary')}
              label="Notes"
              multiline
              fullWidth
            />
          </Grid>

          <Grid item xs={12}>
            <FormControlLabel
              control={(
                <Checkbox
                  checked={localItem.archived}
                  onChange={handleChangeBoolean('archived')}
                />
              )}
              label="Archive"
            />
          </Grid>

          <Grid item xs={12}>
            <TagSelection
              selectedTags={localItem.tags}
              onChange={handleChangeTags}
            />
          </Grid>

          <Grid item />
          <Grid item xs={12}>
            <Typography variant="h5">
              Desired frequency
            </Typography>
          </Grid>

          <FrequencyControls
            item={localItem}
            noInteractions
            onChange={handleChangeFrequency}
          />

          <Grid item />
          <Grid item xs={12}>
            <Typography variant="h5">
              Notes
            </Typography>
          </Grid>

          <Grid item xs={12}>
            <NoteControl
              excludeTypes={['interaction']}
              notes={localItem.notes}
              onChange={handleChangeNotes}
            />
          </Grid>
        </Grid>
      </BaseDrawer>
    </>
  );
}

export default GeneralDrawer;

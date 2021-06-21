import React, {
  ChangeEvent,
  useCallback,
  useEffect,
  useState,
} from 'react';
import makeStyles from '@material-ui/core/styles/makeStyles';
import {
  Container,
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
import FrequencyPicker from '../FrequencyPicker';
import { InteractionIcon, PrayerIcon } from '../Icons';
import { Frequency } from '../../utils/frequencies';


const useStyles = makeStyles(theme => ({
  drawerContainer: {
    overflowX: 'hidden',
    overflowY: 'auto',
    paddingTop: theme.spacing(2),
    paddingBottom: theme.spacing(2),
    flexGrow: 1,
    display: 'flex',
    flexDirection: 'column',
  },
  filler: {
    flexGrow: 1,
  },
}));

export interface Props extends ItemDrawerProps {
  item: GeneralItem | undefined,
}


function GeneralDrawer({
  item,
  onClose,
  open,
  stacked,
}: Props) {
  const classes = useStyles();
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
        <Container className={classes.drawerContainer}>
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

            <Grid item xs={12} sm={6}>
              <FrequencyPicker
                frequency={localItem.prayerFrequency}
                onChange={handleChangeFrequency('prayerFrequency')}
                label="Prayer Frequency"
                icon={<PrayerIcon />}
                fullWidth
              />
            </Grid>
            <Grid item xs={12} sm={6}>
              <FrequencyPicker
                frequency={localItem.interactionFrequency}
                onChange={handleChangeFrequency('interactionFrequency')}
                label="Interaction Frequency"
                icon={<InteractionIcon />}
                fullWidth
              />
            </Grid>

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

          <div className={classes.filler} />

          <DrawerActions
            canSave={valid}
            item={item}
            onCancel={handleCancel}
            onDelete={handleDelete}
            onSave={handleSave}
          />
        </Container>
      </BaseDrawer>
    </>
  );
}

export default GeneralDrawer;

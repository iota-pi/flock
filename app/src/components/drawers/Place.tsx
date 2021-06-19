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
} from '@material-ui/core';
import {
  deleteItems,
  getBlankPlace,
  ItemNote,
  PlaceItem,
  updateItems,
} from '../../state/items';
import { useAppDispatch } from '../../store';
import NoteDisplay from '../NoteDisplay';
import { useVault } from '../../state/selectors';
import BaseDrawer, { ItemDrawerProps } from './BaseDrawer';
import DrawerActions from '../DrawerActions';


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
  item: PlaceItem | undefined,
}


function PlaceDrawer({
  item: place,
  onClose,
  open,
  stacked,
}: Props) {
  const classes = useStyles();
  const dispatch = useAppDispatch();
  const vault = useVault();

  const [localPlace, setLocalPlace] = useState(getBlankPlace());

  const valid = !!localPlace.name;

  useEffect(
    () => {
      if (place) {
        setLocalPlace({ ...place });
      } else {
        setLocalPlace(getBlankPlace());
      }
    },
    [place],
  );

  const handleChange = useCallback(
    (key: keyof PlaceItem) => (
      (e: ChangeEvent<HTMLInputElement>) => {
        const value = e.target.value;
        setLocalPlace({ ...localPlace, [key]: value });
      }
    ),
    [localPlace],
  );
  const handleChangeNotes = useCallback(
    (newNotes: ItemNote[]) => setLocalPlace({ ...localPlace, notes: newNotes }),
    [localPlace],
  );
  const handleSave = useCallback(
    async () => {
      localPlace.name = localPlace.name.trim();
      if (valid) {
        vault?.store(localPlace);
        dispatch(updateItems([localPlace]));
        setLocalPlace(getBlankPlace());
      }
      onClose();
    },
    [dispatch, localPlace, onClose, valid, vault],
  );
  const handleCancel = useCallback(
    () => {
      setLocalPlace(getBlankPlace());
      onClose();
    },
    [onClose],
  );
  const handleDelete = useCallback(
    () => {
      vault?.delete(localPlace.id);
      dispatch(deleteItems([localPlace]));
      setLocalPlace(getBlankPlace());
      onClose();
    },
    [dispatch, onClose, localPlace, vault],
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
              <TextField
                value={localPlace.name}
                onChange={handleChange('name')}
                label="Place Name"
                required
                fullWidth
              />
            </Grid>

            <Grid item xs={12}>
              <TextField
                value={localPlace.description}
                onChange={handleChange('description')}
                label="Description"
                multiline
                fullWidth
              />
            </Grid>

            <Grid item xs={12}>
              <NoteDisplay
                notes={localPlace.notes}
                onChange={handleChangeNotes}
              />
            </Grid>
          </Grid>

          <div className={classes.filler} />

          <DrawerActions
            canSave={valid}
            item={place}
            onCancel={handleCancel}
            onDelete={handleDelete}
            onSave={handleSave}
          />
        </Container>
      </BaseDrawer>
    </>
  );
}

export default PlaceDrawer;

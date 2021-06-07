import React, {
  ChangeEvent,
  useCallback,
  useEffect,
  useState,
} from 'react';
import makeStyles from '@material-ui/core/styles/makeStyles';
import {
  Button,
  Container,
  Divider,
  fade,
  Grid,
  TextField,
  Typography,
} from '@material-ui/core';
import DeleteIcon from '@material-ui/icons/DeleteOutline';
import SaveIcon from '@material-ui/icons/Check';
import {
  deleteItems,
  getBlankPlace,
  getItemName,
  ItemNote,
  PlaceItem,
  updateItems,
} from '../../state/items';
import { useAppDispatch } from '../../store';
import NoteDisplay from '../NoteDisplay';
import ConfirmationDialog from '../ConfirmationDialog';
import { useVault } from '../../state/selectors';
import BaseDrawer, { ItemDrawerProps } from './BaseDrawer';


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
  danger: {
    borderColor: theme.palette.error.light,
    color: theme.palette.error.light,

    '&:hover': {
      backgroundColor: fade(theme.palette.error.light, 0.08),
    },
  },
  emphasis: {
    fontWeight: 500,
  },
}));

export interface Props extends ItemDrawerProps {
  place: PlaceItem | undefined,
}


function PlaceDrawer({
  place,
  onClose,
  open,
  stacked,
}: Props) {
  const classes = useStyles();
  const dispatch = useAppDispatch();
  const vault = useVault();

  const [localPlace, setLocalPlace] = useState(getBlankPlace());
  const [showConfirm, setShowConfirm] = useState(false);

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
  const handleDelete = useCallback(
    () => {
      if (place) {
        setShowConfirm(true);
      } else {
        setLocalPlace(getBlankPlace());
        onClose();
      }
    },
    [onClose, place],
  );
  const handleConfirmDelete = useCallback(
    () => {
      vault?.delete(localPlace.id);
      dispatch(deleteItems([localPlace]));
      setShowConfirm(false);
      setLocalPlace(getBlankPlace());
      onClose();
    },
    [dispatch, onClose, localPlace, vault],
  );
  const handleConfirmCancel = useCallback(() => setShowConfirm(false), []);

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

          <Grid container spacing={2}>
            <Grid item xs={12}>
              <Divider />
            </Grid>

            <Grid item xs={12} sm={6}>
              <Button
                onClick={handleDelete}
                variant="outlined"
                fullWidth
                className={place ? classes.danger : undefined}
                startIcon={place ? <DeleteIcon /> : undefined}
              >
                {place ? 'Delete' : 'Cancel'}
              </Button>
            </Grid>

            <Grid item xs={12} sm={6}>
              <Button
                color="primary"
                onClick={handleSave}
                variant="contained"
                fullWidth
                disabled={!valid}
                startIcon={<SaveIcon />}
              >
                Done
              </Button>
            </Grid>
          </Grid>
        </Container>
      </BaseDrawer>

      <ConfirmationDialog
        open={showConfirm}
        onConfirm={handleConfirmDelete}
        onCancel={handleConfirmCancel}
      >
        <Typography paragraph>
          Are you sure you want to delete
          {' '}
          <span className={classes.emphasis}>{getItemName(localPlace)}</span>
          , and all associated notes?
        </Typography>

        <Typography paragraph>
          This action cannot be undone.
        </Typography>
      </ConfirmationDialog>
    </>
  );
}

export default PlaceDrawer;

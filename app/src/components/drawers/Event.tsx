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
  EventItem,
  getBlankEvent,
  getItemName,
  ItemNote,
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
  event: EventItem | undefined,
}


function EventDrawer({
  event,
  onClose,
  open,
  stacked,
}: Props) {
  const classes = useStyles();
  const dispatch = useAppDispatch();
  const vault = useVault();

  const [localEvent, setLocalEvent] = useState(getBlankEvent());
  const [showConfirm, setShowConfirm] = useState(false);

  const valid = !!localEvent.name;

  useEffect(
    () => {
      if (event) {
        setLocalEvent({ ...event });
      } else {
        setLocalEvent(getBlankEvent());
      }
    },
    [event],
  );

  const handleChange = useCallback(
    (key: keyof EventItem) => (
      (e: ChangeEvent<HTMLInputElement>) => {
        const value = e.target.value;
        setLocalEvent({ ...localEvent, [key]: value });
      }
    ),
    [localEvent],
  );
  const handleChangeNotes = useCallback(
    (newNotes: ItemNote[]) => setLocalEvent({ ...localEvent, notes: newNotes }),
    [localEvent],
  );
  const handleSave = useCallback(
    async () => {
      localEvent.name = localEvent.name.trim();
      if (valid) {
        vault?.store(localEvent);
        dispatch(updateItems([localEvent]));
        setLocalEvent(getBlankEvent());
      }
      onClose();
    },
    [dispatch, localEvent, onClose, valid, vault],
  );
  const handleDelete = useCallback(
    () => {
      if (event) {
        setShowConfirm(true);
      } else {
        setLocalEvent(getBlankEvent());
        onClose();
      }
    },
    [onClose, event],
  );
  const handleConfirmDelete = useCallback(
    () => {
      vault?.delete(localEvent.id);
      dispatch(deleteItems([localEvent]));
      setShowConfirm(false);
      setLocalEvent(getBlankEvent());
      onClose();
    },
    [dispatch, onClose, localEvent, vault],
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
                value={localEvent.name}
                onChange={handleChange('name')}
                label="Event Name"
                required
                fullWidth
              />
            </Grid>

            <Grid item xs={12}>
              <TextField
                value={localEvent.description}
                onChange={handleChange('description')}
                label="Description"
                multiline
                fullWidth
              />
            </Grid>

            <Grid item xs={12}>
              <NoteDisplay
                notes={localEvent.notes}
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
                className={event ? classes.danger : undefined}
                startIcon={event ? <DeleteIcon /> : undefined}
              >
                {event ? 'Delete' : 'Cancel'}
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
          <span className={classes.emphasis}>{getItemName(localEvent)}</span>
          , and all associated notes?
        </Typography>

        <Typography paragraph>
          This action cannot be undone.
        </Typography>
      </ConfirmationDialog>
    </>
  );
}

export default EventDrawer;

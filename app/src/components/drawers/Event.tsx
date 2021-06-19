import React, {
  ChangeEvent,
  useCallback,
  useEffect,
  useState,
} from 'react';
import makeStyles from '@material-ui/core/styles/makeStyles';
import {
  Container,
  fade,
  Grid,
  TextField,
} from '@material-ui/core';
import {
  deleteItems,
  EventItem,
  getBlankEvent,
  ItemNote,
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
  item: EventItem | undefined,
}


function EventDrawer({
  item: event,
  onClose,
  open,
  stacked,
}: Props) {
  const classes = useStyles();
  const dispatch = useAppDispatch();
  const vault = useVault();

  const [localEvent, setLocalEvent] = useState(getBlankEvent());

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
  const handleCancel = useCallback(
    () => {
      setLocalEvent(getBlankEvent());
      onClose();
    },
    [onClose],
  );
  const handleDelete = useCallback(
    () => {
      vault?.delete(localEvent.id);
      dispatch(deleteItems([localEvent]));
      setLocalEvent(getBlankEvent());
      onClose();
    },
    [dispatch, onClose, localEvent, vault],
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

          <DrawerActions
            canSave={valid}
            item={event}
            onCancel={handleCancel}
            onDelete={handleDelete}
            onSave={handleSave}
          />
        </Container>
      </BaseDrawer>
    </>
  );
}

export default EventDrawer;

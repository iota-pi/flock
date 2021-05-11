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
  Drawer,
  fade,
  Grid,
  TextField,
  Typography,
} from '@material-ui/core';
import DeleteIcon from '@material-ui/icons/DeleteOutline';
import SaveIcon from '@material-ui/icons/Check';
import { deleteItems, getBlankPerson, getItemName, ItemNote, ItemNoteType, PersonItem, updateItems } from '../../state/items';
import { useAppDispatch, useVault } from '../../store';
import NoteDisplay from '../NoteDisplay';
import ConfirmationDialog from '../ConfirmationDialog';


const useStyles = makeStyles(theme => ({
  drawer: {
    flexShrink: 0,

    width: '60%',
    [theme.breakpoints.only('sm')]: {
      width: '70%',
    },
    [theme.breakpoints.only('xs')]: {
      width: '100%',
    },
  },
  drawerPaper: {
    width: '60%',
    [theme.breakpoints.only('sm')]: {
      width: '70%',
    },
    [theme.breakpoints.only('xs')]: {
      width: '100%',
    },
  },
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
  notesHeader: {
    marginTop: theme.spacing(4),
    width: '100%',
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
  },
  listItemColumn: {
    flexDirection: 'column',
  },
  noteDate: {
    alignSelf: 'flex-end',
    padding: theme.spacing(1),
  },
  emphasis: {
    fontWeight: 500,
  },
}));

export interface Props {
  onClose: () => void,
  open: boolean,
  person: PersonItem | undefined,
}

const ALL_NOTE_TYPES = 'all';
export const noteFilterOptions: [ItemNoteType | typeof ALL_NOTE_TYPES, string][] = [
  [ALL_NOTE_TYPES, 'All Notes'],
  ['general', 'General Notes'],
  ['prayer', 'Prayer Points'],
  ['interaction', 'Interactions'],
];


function PersonDrawer({
  onClose,
  open,
  person,
}: Props) {
  const classes = useStyles();
  const dispatch = useAppDispatch();
  const vault = useVault();

  const [localPerson, setLocalPerson] = useState(getBlankPerson());
  const [showConfirm, setShowConfirm] = useState(false);

  useEffect(
    () => {
      if (person) {
        setLocalPerson({ ...person });
      } else {
        setLocalPerson(getBlankPerson());
      }
    },
    [person],
  );

  const handleChange = useCallback(
    (key: keyof PersonItem) => (
      (event: ChangeEvent<HTMLInputElement>) => {
        const value = event.target.value;
        setLocalPerson({ ...localPerson, [key]: value });
      }
    ),
    [localPerson],
  );
  const handleChangeNotes = useCallback(
    (newNotes: ItemNote[]) => setLocalPerson({ ...localPerson, notes: newNotes }),
    [localPerson],
  );

  const valid = !!localPerson.firstName && !!localPerson.lastName;

  const handleSave = useCallback(
    async () => {
      localPerson.firstName = localPerson.firstName.trim();
      localPerson.lastName = localPerson.lastName.trim();
      localPerson.email = localPerson.email.trim();
      localPerson.phone = localPerson.phone.trim();
      if (valid) {
        vault?.store(localPerson);
        dispatch(updateItems([localPerson]));
        setLocalPerson(getBlankPerson());
      }
      onClose();
    },
    [dispatch, localPerson, onClose, valid, vault],
  );
  const handleDelete = useCallback(
    () => {
      if (person) {
        setShowConfirm(true);
      } else {
        setLocalPerson(getBlankPerson());
        onClose();
      }
    },
    [onClose, person],
  );
  const handleConfirmedDelete = useCallback(
    () => {
      vault?.delete(localPerson.id);
      dispatch(deleteItems([localPerson]));
      setShowConfirm(false);
      setLocalPerson(getBlankPerson());
      onClose();
    },
    [dispatch, onClose, localPerson, vault],
  );
  const handleCancel = useCallback(() => setShowConfirm(false), []);

  return (
    <>
      <Drawer
        className={classes.drawer}
        variant="temporary"
        open={open}
        onClose={handleSave}
        anchor="right"
        classes={{
          paper: classes.drawerPaper,
        }}
      >
        <Container className={classes.drawerContainer}>
          <Grid container spacing={2}>
            <Grid item xs={12} sm={6}>
              <TextField
                value={localPerson.firstName}
                onChange={handleChange('firstName')}
                label="First Name"
                required
                fullWidth
              />
            </Grid>
            <Grid item xs={12} sm={6}>
              <TextField
                value={localPerson.lastName}
                onChange={handleChange('lastName')}
                label="Last Name"
                required
                fullWidth
              />
            </Grid>

            <Grid item xs={12} sm={6}>
              <TextField
                value={localPerson.email}
                onChange={handleChange('email')}
                label="Email"
                fullWidth
              />
            </Grid>
            <Grid item xs={12} sm={6}>
              <TextField
                value={localPerson.phone}
                onChange={handleChange('phone')}
                label="Phone"
                fullWidth
              />
            </Grid>

            <Grid item xs={12}>
              <TextField
                value={localPerson.description}
                onChange={handleChange('description')}
                label="Description"
                multiline
                fullWidth
              />
            </Grid>

            <Grid item xs={12}>
              <NoteDisplay
                notes={localPerson.notes}
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
                className={person ? classes.danger : undefined}
                startIcon={person ? <DeleteIcon /> : undefined}
              >
                {person ? 'Delete' : 'Cancel'}
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
      </Drawer>

      <ConfirmationDialog
        open={showConfirm}
        onConfirm={handleConfirmedDelete}
        onCancel={handleCancel}
      >
        <Typography paragraph>
          Are you sure you want to delete
          {' '}
          <span className={classes.emphasis}>{getItemName(localPerson)}</span>
          , and all associated notes?
        </Typography>

        <Typography paragraph>
          This action cannot be undone.
        </Typography>
      </ConfirmationDialog>
    </>
  );
}

export default PersonDrawer;

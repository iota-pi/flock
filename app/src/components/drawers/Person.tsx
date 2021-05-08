import React, {
  ChangeEvent,
  ReactNode,
  useCallback,
  useEffect,
  useMemo,
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
  IconButton,
  List,
  ListItem,
  TextField,
  Typography,
} from '@material-ui/core';
import DownArrow from '@material-ui/icons/ArrowDropDown';
import UpArrow from '@material-ui/icons/ArrowDropUp';
import { deleteItems, getBlankPerson, ItemNote, PersonItem, updateItems } from '../../state/items';
import { useAppDispatch, useVault } from '../../store';
import { formatDateAndTime, getItemId } from '../../utils';


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
}));

export interface Props {
  onClose: () => void,
  open: boolean,
  person: PersonItem | undefined,
}

export interface UserInterface {
  id: string,
  name: string,
  icon: ReactNode,
}


function PersonDrawer({
  onClose,
  open,
  person,
}: Props) {
  const classes = useStyles();
  const dispatch = useAppDispatch();
  const vault = useVault();

  const [localPerson, setLocalPerson] = useState(getBlankPerson());
  const [ascendingNotes, setAscendingNotes] = useState(false);

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
  const notes = useMemo(
    () => {
      const sortedNotes = localPerson.notes.slice();
      sortedNotes.sort((a, b) => +(a.date < b.date) - +(a.date > b.date));
      if (ascendingNotes) {
        sortedNotes.reverse();
      }
      return sortedNotes;
    },
    [ascendingNotes, localPerson],
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
  const handleChangeNote = useCallback(
    (noteId: string) => (
      (event: ChangeEvent<HTMLInputElement>) => {
        const index = localPerson.notes.findIndex(n => n.id === noteId);
        if (index > -1) {
          const newNotes = localPerson.notes.slice();
          newNotes[index].content = event.target.value;
          setLocalPerson({ ...localPerson, notes: localPerson.notes.slice() });
        }
      }
    ),
    [localPerson],
  );
  const valid = !!localPerson.firstName && !!localPerson.lastName;

  const handleAddNote = useCallback(
    () => {
      const id = getItemId();
      const note: ItemNote = {
        id,
        content: '',
        date: new Date().getTime(),
        type: 'general',
      };
      setLocalPerson({ ...localPerson, notes: [...localPerson.notes, note] });
    },
    [localPerson],
  );

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
    async () => {
      setLocalPerson(getBlankPerson());
      if (person) {
        vault?.delete(person.id);
        dispatch(deleteItems([person]));
      }
      onClose();
    },
    [dispatch, onClose, person, vault],
  );
  const handleClickNoteOrder = useCallback(
    () => setAscendingNotes(!ascendingNotes),
    [ascendingNotes],
  );

  return (
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
            <div className={classes.notesHeader}>
              <Typography className={classes.filler}>
                Notes
              </Typography>

              <IconButton
                onClick={handleClickNoteOrder}
                size="small"
              >
                {ascendingNotes ? <UpArrow /> : <DownArrow />}
              </IconButton>
            </div>

            <List>
              <Divider />

              {notes.map(note => (
                <React.Fragment key={note.id}>
                  <ListItem
                    disableGutters
                    className={classes.listItemColumn}
                  >
                    <TextField
                      value={note.content}
                      onChange={handleChangeNote(note.id)}
                      label="Note"
                      multiline
                      fullWidth
                    />

                    <div className={classes.noteDate}>
                      {formatDateAndTime(new Date(note.date))}
                    </div>
                  </ListItem>
                  <Divider />
                </React.Fragment>
              ))}
            </List>

            <Button
              fullWidth
              size="small"
              variant="outlined"
              color="secondary"
              onClick={handleAddNote}
            >
              +
            </Button>
          </Grid>
        </Grid>

        <div className={classes.filler} />

        <Grid container spacing={2}>
          <Grid item xs={12}>
            <Divider />
          </Grid>

          <Grid item xs={12}>
            <Button
              onClick={handleDelete}
              variant="outlined"
              fullWidth
              className={person ? classes.danger : undefined}
            >
              {person ? 'Delete' : 'Cancel'}
            </Button>
          </Grid>

          <Grid item xs={12}>
            <Button
              color="primary"
              onClick={handleSave}
              variant="contained"
              fullWidth
              disabled={!valid}
            >
              Done
            </Button>
          </Grid>
        </Grid>
      </Container>
    </Drawer>
  );
}

export default PersonDrawer;

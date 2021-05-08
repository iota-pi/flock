import React, {
  ChangeEvent,
  useCallback,
  useMemo,
  useState,
} from 'react';
import makeStyles from '@material-ui/core/styles/makeStyles';
import {
  Button,
  Divider,
  fade,
  IconButton,
  List,
  ListItem,
  MenuItem,
  Select,
  TextField,
} from '@material-ui/core';
import DownArrow from '@material-ui/icons/ArrowDropDown';
import UpArrow from '@material-ui/icons/ArrowDropUp';
import { ItemNote, ItemNoteType } from '../state/items';
import { formatDateAndTime, getItemId } from '../utils';


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
  notes: ItemNote[],
  onChange: (notes: ItemNote[]) => void,
}


const ALL_NOTE_TYPES = 'all';
export const noteFilterOptions: [ItemNoteType | typeof ALL_NOTE_TYPES, string][] = [
  [ALL_NOTE_TYPES, 'All Notes'],
  ['general', 'General Notes'],
  ['prayer', 'Prayer Points'],
  ['interaction', 'Interactions'],
];


function NoteDisplay({
  notes: rawNotes,
  onChange,
}: Props) {
  const classes = useStyles();

  const [ascendingNotes, setAscendingNotes] = useState(false);
  const [notesType, setNotesType] = useState<ItemNoteType | typeof ALL_NOTE_TYPES>(ALL_NOTE_TYPES);

  const notes = useMemo(
    () => {
      const filteredNotes = rawNotes.filter(
        note => notesType === ALL_NOTE_TYPES || notesType === note.type,
      );
      filteredNotes.sort((a, b) => +(a.date < b.date) - +(a.date > b.date));
      if (ascendingNotes) {
        filteredNotes.reverse();
      }
      return filteredNotes;
    },
    [ascendingNotes, rawNotes, notesType],
  );

  const handleChange = useCallback(
    (noteId: string) => (
      (event: ChangeEvent<HTMLInputElement>) => {
        const index = notes.findIndex(n => n.id === noteId);
        if (index > -1) {
          const newNotes = notes.slice();
          newNotes[index].content = event.target.value;
          onChange(newNotes);
        }
      }
    ),
    [notes, onChange],
  );
  const handleChangeNoteType = useCallback(
    (event: ChangeEvent<{ value: unknown }>) => {
      setNotesType(event.target.value as ItemNoteType);
    },
    [],
  );
  const handleClickNoteOrder = useCallback(
    () => setAscendingNotes(!ascendingNotes),
    [ascendingNotes],
  );

  const handleAddNote = useCallback(
    () => {
      const id = getItemId();
      const note: ItemNote = {
        id,
        content: '',
        date: new Date().getTime(),
        type: 'general',
      };
      onChange([...notes, note]);
    },
    [notes, onChange],
  );

  return (
    <>
      <div className={classes.notesHeader}>
        <Select
          id="note-type-filter"
          value={notesType}
          onChange={handleChangeNoteType}
        >
          {noteFilterOptions.map(([value, label]) => (
            <MenuItem
              key={label}
              value={value}
            >
              {label}
            </MenuItem>
          ))}
        </Select>

        <div className={classes.filler} />

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
                onChange={handleChange(note.id)}
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
        Add Note
      </Button>
    </>
  );
}

export default NoteDisplay;

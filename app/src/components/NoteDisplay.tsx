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
  Grid,
  IconButton,
  MenuItem,
  Select,
  TextField,
} from '@material-ui/core';
import DownArrow from '@material-ui/icons/ArrowDropDown';
import UpArrow from '@material-ui/icons/ArrowDropUp';
import { ItemNote, ItemNoteType } from '../state/items';
import { formatDateAndTime, getItemId } from '../utils';

const NOTE_TYPE_SELECT_WIDTH = 128;

const useStyles = makeStyles(theme => ({
  filler: {
    flexGrow: 1,
  },
  notesHeader: {
    marginTop: theme.spacing(4),
    marginBottom: theme.spacing(2),
    width: '100%',
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
  },
  noteFilter: {
    minWidth: NOTE_TYPE_SELECT_WIDTH,
  },
  noteDivider: {
    flexGrow: 1,
  },
  noteContentRow: {
    display: 'flex',
    flexDirection: 'row',
  },
  noteType: {
    marginRight: theme.spacing(2),
    minWidth: NOTE_TYPE_SELECT_WIDTH,
  },
  noteDate: {
    textAlign: 'right',
    flexGrow: 1,
    padding: theme.spacing(1),
    color: theme.palette.text.hint,
  },
  subtle: {
    fontWeight: 300,
  },
}));

export interface Props {
  notes: ItemNote[],
  onChange: (notes: ItemNote[]) => void,
}


const ALL_TYPES = 'all';
export const noteFilterOptions: [ItemNoteType | typeof ALL_TYPES, string][] = [
  [ALL_TYPES, 'All Notes'],
  ['general', 'General Notes'],
  ['prayer', 'Prayer Points'],
  ['interaction', 'Interactions'],
];
export const noteTypeOptions: [ItemNoteType, string][] = [
  ['general', 'General'],
  ['prayer', 'Prayer Point'],
  ['interaction', 'Interaction'],
];


function NoteDisplay({
  notes: rawNotes,
  onChange,
}: Props) {
  const classes = useStyles();

  const [ascendingNotes, setAscendingNotes] = useState(false);
  const [filterType, setFilterType] = useState<ItemNoteType | typeof ALL_TYPES>(ALL_TYPES);

  const notes = useMemo(
    () => {
      const filteredNotes = rawNotes.filter(
        note => filterType === ALL_TYPES || filterType === note.type,
      );
      filteredNotes.sort((a, b) => +(a.date < b.date) - +(a.date > b.date));
      if (ascendingNotes) {
        filteredNotes.reverse();
      }
      return filteredNotes;
    },
    [ascendingNotes, filterType, rawNotes],
  );

  const handleChange = useCallback(
    (noteId: string) => (
      (event: ChangeEvent<HTMLInputElement>) => {
        const index = rawNotes.findIndex(n => n.id === noteId);
        if (index > -1) {
          const newNotes = rawNotes.slice();
          newNotes[index] = { ...newNotes[index], content: event.target.value };
          onChange(newNotes);
        }
      }
    ),
    [rawNotes, onChange],
  );
  const handleChangeNoteType = useCallback(
    (noteId: string) => (
      (event: ChangeEvent<{ value: unknown }>) => {
        const index = rawNotes.findIndex(n => n.id === noteId);
        if (index > -1) {
          const newNotes = rawNotes.slice();
          newNotes[index] = { ...newNotes[index], type: event.target.value as ItemNoteType };
          onChange(newNotes);
        }
      }
    ),
    [rawNotes, onChange],
  );
  const handleChangeFilterType = useCallback(
    (event: ChangeEvent<{ value: unknown }>) => {
      setFilterType(event.target.value as ItemNoteType);
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
          value={filterType}
          onChange={handleChangeFilterType}
          className={classes.noteFilter}
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

      <Grid container spacing={2}>
        <Grid item className={classes.noteDivider}>
          <Divider />
        </Grid>

        {notes.map(note => (
          <React.Fragment key={note.id}>
            <Grid item xs={12}>
              <div className={classes.noteContentRow}>
                <Select
                  id="note-type-selection"
                  value={note.type}
                  onChange={handleChangeNoteType(note.id)}
                  className={classes.noteType}
                >
                  {noteTypeOptions.map(([value, label]) => (
                    <MenuItem
                      key={label}
                      value={value}
                    >
                      {label}
                    </MenuItem>
                  ))}
                </Select>

                <TextField
                  value={note.content}
                  onChange={handleChange(note.id)}
                  label="Content"
                  multiline
                  fullWidth
                />
              </div>

              <div className={classes.noteContentRow}>
                <div className={classes.noteDate}>
                  <span className={classes.subtle}>
                    {'Created: '}
                  </span>
                  {formatDateAndTime(new Date(note.date))}
                </div>
              </div>
            </Grid>

            <Grid item className={classes.noteDivider}>
              <Divider />
            </Grid>
          </React.Fragment>
        ))}
      </Grid>

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

import React, {
  ChangeEvent,
  useCallback,
  useMemo,
  useState,
} from 'react';
import makeStyles from '@material-ui/core/styles/makeStyles';
import {
  Button,
  Checkbox,
  Divider,
  FormControlLabel,
  Grid,
  IconButton,
  InputAdornment,
  TextField,
  Typography,
} from '@material-ui/core';
import {
  KeyboardDatePicker,
} from '@material-ui/pickers';
import { MaterialUiPickersDate } from '@material-ui/pickers/typings/date';
import Visibility from '@material-ui/icons/Visibility';
import VisibilityOff from '@material-ui/icons/VisibilityOff';
import { DeleteIcon } from './Icons';
import { compareNotes, getBlankNote, ItemId, ItemNote } from '../state/items';
import { formatDate } from '../utils';
import ConfirmationDialog from './dialogs/ConfirmationDialog';

const NOTE_TYPE_SELECT_WIDTH = 144;

const useStyles = makeStyles(theme => ({
  filler: {
    flexGrow: 1,
  },
  notesHeader: {
    marginBottom: theme.spacing(2),
    width: '100%',
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
  },
  noteFilter: {
    minWidth: NOTE_TYPE_SELECT_WIDTH,
  },
  noteContentRow: {
    display: 'flex',
    flexDirection: 'row',

    '&$center': {
      alignItems: 'center',
    },
  },
  center: {},
  firstFieldOfRow: {
    marginRight: theme.spacing(2),
    minWidth: NOTE_TYPE_SELECT_WIDTH,
    width: NOTE_TYPE_SELECT_WIDTH,
  },
  noteDate: {
    flexGrow: 1,
    padding: theme.spacing(1),
    paddingLeft: 0,
    color: theme.palette.text.hint,
  },
  danger: {
    color: theme.palette.error.light,
  },
}));

export interface Props<T extends ItemNote> {
  noNotesText?: string,
  noteType: T['type'],
  notes: T[],
  onChange: (notes: T[]) => void,
}

function AddNoteButton(
  { label, onClick }: { label: string, onClick: () => void },
) {
  return (
    <Button
      fullWidth
      size="small"
      variant="outlined"
      onClick={onClick}
    >
      {label}
    </Button>
  );
}


function NoteControl<T extends ItemNote>({
  noNotesText,
  noteType,
  notes: rawNotes,
  onChange,
}: Props<T>) {
  const classes = useStyles();

  const notes = useMemo(
    () => rawNotes.filter(note => note.type === noteType).sort(compareNotes),
    [noteType, rawNotes],
  );
  const [autoFocus, setAutoFocus] = useState<string>();
  const [noteToDelete, setNoteToDelete] = useState<ItemId>();
  const [visibleSensitives, setVisibleSensitives] = useState<string[]>([]);

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
    [onChange, rawNotes],
  );
  const handleChangeSensitive = useCallback(
    (noteId: string) => (
      () => {
        const index = rawNotes.findIndex(n => n.id === noteId);
        if (index > -1) {
          const newNotes = rawNotes.slice();
          newNotes[index] = { ...newNotes[index], sensitive: !newNotes[index].sensitive };
          onChange(newNotes);
        }
      }
    ),
    [onChange, rawNotes],
  );
  const handleDateChange = useCallback(
    (noteId: string) => (
      (date: MaterialUiPickersDate) => {
        const defaultedDate = date || new Date();
        const index = rawNotes.findIndex(n => n.id === noteId);
        if (index > -1) {
          const newNotes = rawNotes.slice();
          newNotes[index] = { ...newNotes[index], date: defaultedDate.getTime() };
          onChange(newNotes);
        }
      }
    ),
    [onChange, rawNotes],
  );
  const handleDelete = useCallback((noteId: string) => () => setNoteToDelete(noteId), []);
  const handleConfirmCancel = useCallback(() => { setNoteToDelete(undefined); }, []);
  const handleConfirmDelete = useCallback(
    () => {
      const newNotes = rawNotes.filter(n => n.id !== noteToDelete);
      onChange(newNotes);
      setNoteToDelete(undefined);
    },
    [noteToDelete, onChange, rawNotes],
  );

  const handleAddNote = useCallback(
    () => {
      const note = getBlankNote(noteType) as T;
      onChange([...rawNotes, note]);
      setAutoFocus(note.id);
    },
    [rawNotes, noteType, onChange],
  );

  const handleClickVisibility = useCallback(
    (note: ItemNote) => () => setVisibleSensitives(currentlyVisible => {
      const index = currentlyVisible.indexOf(note.id);
      if (index > -1) {
        return [
          ...currentlyVisible.slice(0, index),
          ...currentlyVisible.slice(index + 1),
        ];
      }
      return [...currentlyVisible, note.id];
    }),
    [],
  );
  const handleMouseDownVisibility = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => event.preventDefault(),
    [],
  );

  const isNoteVisible = useCallback(
    (note: ItemNote) => !note.sensitive || visibleSensitives.includes(note.id),
    [visibleSensitives],
  );

  const addNoteLabel = useMemo(
    () => {
      if (noteType === 'interaction') {
        return 'Add Interaction';
      } else if (noteType === 'prayer') {
        return 'Add Prayer Point';
      }
      throw new Error(`Unsupported note type ${noteType}`);
    },
    [noteType],
  );
  const noteContentLabel = useMemo(
    () => {
      if (noteType === 'interaction') {
        return 'Details';
      } else if (noteType === 'prayer') {
        return 'Prayer point';
      }
      throw new Error(`Unsupported note type ${noteType}`);
    },
    [noteType],
  );

  return (
    <>
      <AddNoteButton
        label={addNoteLabel}
        onClick={handleAddNote}
      />

      <Grid container spacing={2}>
        <Grid item />

        {notes.map(note => (
          <React.Fragment key={note.id}>
            <Grid item xs={12}>
              <div className={classes.noteContentRow}>
                <TextField
                  autoFocus={autoFocus === note.id}
                  value={!isNoteVisible(note) ? '...' : note.content}
                  onChange={handleChange(note.id)}
                  disabled={!isNoteVisible(note)}
                  label={noteContentLabel}
                  InputProps={{
                    endAdornment: note.sensitive ? (
                      <InputAdornment position="end">
                        <IconButton
                          onClick={handleClickVisibility(note)}
                          onMouseDown={handleMouseDownVisibility}
                        >
                          {isNoteVisible(note) ? <Visibility /> : <VisibilityOff />}
                        </IconButton>
                      </InputAdornment>
                    ) : null,
                  }}
                  multiline
                  fullWidth
                />
              </div>

              <div className={`${classes.noteContentRow} ${classes.center}`}>
                {note.type === 'interaction' ? (
                  <KeyboardDatePicker
                    value={new Date(note.date)}
                    onChange={handleDateChange(note.id)}
                    maxDate={new Date()}
                    maxDateMessage="Only past interactions can be recorded in the present"
                    format="dd/MM/yyyy"
                    InputProps={{
                      className: classes.firstFieldOfRow,
                    }}
                  />
                ) : (
                  <div className={classes.firstFieldOfRow}>
                    <span className={classes.noteDate}>
                      Date: {formatDate(new Date(note.date))}
                    </span>
                  </div>
                )}

                <FormControlLabel
                  control={(
                    <Checkbox
                      checked={note.sensitive || false}
                      onChange={handleChangeSensitive(note.id)}
                    />
                  )}
                  label="Sensitive"
                />

                <div className={classes.filler} />

                <div>
                  <IconButton
                    onClick={handleDelete(note.id)}
                    size="small"
                    className={classes.danger}
                  >
                    <DeleteIcon />
                  </IconButton>
                </div>
              </div>
            </Grid>

            <Grid item xs={12}>
              <Divider />
            </Grid>
          </React.Fragment>
        ))}

        {notes.length === 0 && (
          <>
            <Grid item xs={12}>
              {noNotesText || 'No notes'}
            </Grid>

            <Grid item xs={12} />
          </>
        )}
      </Grid>

      <ConfirmationDialog
        open={noteToDelete !== undefined}
        onConfirm={handleConfirmDelete}
        onCancel={handleConfirmCancel}
      >
        <Typography paragraph>
          Are you sure you want to delete this note?
        </Typography>

        <Typography paragraph>
          This action cannot be undone.
        </Typography>
      </ConfirmationDialog>
    </>
  );
}

export default NoteControl;

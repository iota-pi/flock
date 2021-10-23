import {
  ChangeEvent,
  Fragment,
  memo,
  MouseEvent,
  useCallback,
  useMemo,
  useState,
} from 'react';
import makeStyles from '@material-ui/styles/makeStyles';
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
import { DatePicker } from '@material-ui/lab';
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
    color: theme.palette.text.disabled,
  },
}));

function AddNoteButton(
  { dataCy, label, onClick }: { dataCy?: string, label: string, onClick: () => void },
) {
  return (
    <Button
      data-cy={dataCy}
      fullWidth
      onClick={onClick}
      size="small"
      variant="outlined"
    >
      {label}
    </Button>
  );
}

function SingleNote<T extends ItemNote>({
  autoFocus,
  note,
  noteContentLabel,
  onChangeCompleted,
  onChangeContent,
  onChangeDate,
  onChangeSensitive,
  onDelete,
}: {
  autoFocus: boolean,
  note: T,
  noteContentLabel: string,
  onChangeCompleted: (noteId: string, completed: number | undefined) => void,
  onChangeContent: (noteId: string, content: string) => void,
  onChangeDate: (noteId: string, date: Date) => void,
  onChangeSensitive: (noteId: string, sensitive: boolean) => void,
  onDelete: (note: T) => void,
}) {
  const classes = useStyles();

  const [showSensitive, setShowSensitive] = useState(false);

  const handleChangeCompleted = useCallback(
    () => note.type === 'action' && onChangeCompleted(
      note.id,
      note.completed ? undefined : new Date().getTime(),
    ),
    [note, onChangeCompleted],
  );
  const handleChangeContent = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      onChangeContent(note.id, event.target.value);
    },
    [note, onChangeContent],
  );
  const handleChangeDate = useCallback(
    (date: Date | null) => {
      onChangeDate(note.id, date || new Date());
    },
    [note, onChangeDate],
  );
  const handleChangeSensitive = useCallback(
    () => onChangeSensitive(note.id, !note.sensitive),
    [note, onChangeSensitive],
  );

  const handleDelete = useCallback(
    () => onDelete(note),
    [note, onDelete],
  );
  const handleClickVisibility = useCallback(
    () => setShowSensitive(s => !s),
    [],
  );
  const handleMouseDownVisibility = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => event.preventDefault(),
    [],
  );

  const visible = !note.sensitive || showSensitive;

  return (
    <>
      <Grid item xs={12}>
        <div className={classes.noteContentRow}>
          <TextField
            autoFocus={autoFocus}
            value={!visible ? '...' : note.content}
            onChange={handleChangeContent}
            disabled={!visible}
            label={noteContentLabel}
            InputProps={{
              endAdornment: note.sensitive ? (
                <InputAdornment position="end">
                  <IconButton
                    onClick={handleClickVisibility}
                    onMouseDown={handleMouseDownVisibility}
                    size="large"
                  >
                    {visible ? <Visibility /> : <VisibilityOff />}
                  </IconButton>
                </InputAdornment>
              ) : null,
            }}
            multiline
            fullWidth
            variant="standard"
          />
        </div>

        <div className={`${classes.noteContentRow} ${classes.center}`}>
          {note.type !== 'prayer' ? (
            <DatePicker<Date | null>
              value={new Date(note.date) as Date | null}
              onChange={handleChangeDate}
              minDate={note.type === 'action' ? new Date() : undefined}
              maxDate={note.type === 'interaction' ? new Date() : undefined}
              inputFormat="dd/MM/yyyy"
              renderInput={params => (
                <TextField
                  {...params}
                  InputProps={{
                    ...params.InputProps,
                    className: classes.firstFieldOfRow,
                  }}
                  variant="standard"
                />
              )}
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
                data-cy="sensitive-note"
                onChange={handleChangeSensitive}
              />
            )}
            label="Sensitive"
          />

          {note.type === 'action' && (
            <FormControlLabel
              control={(
                <Checkbox
                  checked={!!note.completed}
                  data-cy="sensitive-note"
                  onChange={handleChangeCompleted}
                />
              )}
              label="Completed"
            />
          )}

          <div className={classes.filler} />

          <div>
            <IconButton
              color="error"
              data-cy="delete-note"
              onClick={handleDelete}
              size="small"
            >
              <DeleteIcon />
            </IconButton>
          </div>
        </div>
      </Grid>

      <Grid item xs={12}>
        <Divider />
      </Grid>
    </>
  );
}
const MemoSingleNote = memo(SingleNote) as typeof SingleNote;


export interface Props<T extends ItemNote> {
  noNotesText?: string,
  noteType: T['type'],
  notes: T[],
  onChange: (callback: (prevNotes: T[]) => T[]) => void,
}

function NoteControl<T extends ItemNote>({
  noNotesText,
  noteType,
  notes: rawNotes,
  onChange,
}: Props<T>) {
  const [autoFocus, setAutoFocus] = useState<string>();
  const [noteToDelete, setNoteToDelete] = useState<ItemId>();

  const notes = useMemo(
    () => rawNotes.filter(note => note.type === noteType).sort(compareNotes),
    [noteType, rawNotes],
  );

  const handleChangeCompleted = useCallback(
    (noteId: string, completed: number | undefined) => onChange(prevNotes => {
      const index = prevNotes.findIndex(n => n.id === noteId);
      if (index > -1) {
        const newNotes = prevNotes.slice();
        const note = newNotes[index];
        if (note.type === 'action') {
          newNotes[index] = { ...note, completed };
          return newNotes;
        }
      }
      return prevNotes;
    }),
    [onChange],
  );
  const handleChangeContent = useCallback(
    (noteId: string, content: string) => onChange(prevNotes => {
      const index = prevNotes.findIndex(n => n.id === noteId);
      if (index > -1) {
        const newNotes = prevNotes.slice();
        newNotes[index] = { ...newNotes[index], content };
        return newNotes;
      }
      return prevNotes;
    }),
    [onChange],
  );
  const handleChangeDate = useCallback(
    (noteId: string, date: Date | null) => onChange(prevNotes => {
      const defaultedDate = date || new Date();
      const index = prevNotes.findIndex(n => n.id === noteId);
      if (index > -1) {
        const newNotes = prevNotes.slice();
        newNotes[index] = { ...newNotes[index], date: defaultedDate.getTime() };
        return newNotes;
      }
      return prevNotes;
    }),
    [onChange],
  );
  const handleChangeSensitive = useCallback(
    (noteId: string, sensitive: boolean) => onChange(prevNotes => {
      const index = prevNotes.findIndex(n => n.id === noteId);
      if (index > -1) {
        const newNotes = prevNotes.slice();
        newNotes[index] = { ...newNotes[index], sensitive };
        return newNotes;
      }
      return prevNotes;
    }),
    [onChange],
  );
  const handleConfirmCancel = useCallback(() => setNoteToDelete(undefined), []);
  const handleConfirmDelete = useCallback(
    (deleteId: ItemId) => onChange(prevNotes => {
      const newNotes = prevNotes.filter(n => n.id !== deleteId);
      setNoteToDelete(undefined);
      return newNotes;
    }),
    [onChange],
  );
  const handleDelete = useCallback(
    (note: T) => {
      if (!note.content) {
        handleConfirmDelete(note.id);
      } else {
        setNoteToDelete(note.id);
      }
    },
    [handleConfirmDelete],
  );

  const handleAddNote = useCallback(
    () => {
      const note = getBlankNote(noteType) as T;
      onChange(ln => [...ln, note]);
      setAutoFocus(note.id);
    },
    [onChange, noteType],
  );

  const addNoteLabel = useMemo(
    () => {
      if (noteType === 'interaction') {
        return 'Add Interaction';
      } else if (noteType === 'prayer') {
        return 'Add Prayer Point';
      } else if (noteType === 'action') {
        return 'Add Action';
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
      } else if (noteType === 'action') {
        return 'Action';
      }
      throw new Error(`Unsupported note type ${noteType}`);
    },
    [noteType],
  );

  return (
    <>
      <AddNoteButton
        dataCy={`add-${noteType}`}
        label={addNoteLabel}
        onClick={handleAddNote}
      />

      <Grid container spacing={2}>
        <Grid item />

        {notes.map(note => (
          <Fragment key={note.id}>
            <MemoSingleNote
              autoFocus={autoFocus === note.id}
              note={note}
              noteContentLabel={noteContentLabel}
              onChangeCompleted={handleChangeCompleted}
              onChangeContent={handleChangeContent}
              onChangeDate={handleChangeDate}
              onChangeSensitive={handleChangeSensitive}
              onDelete={handleDelete}
            />
          </Fragment>
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
        onConfirm={() => noteToDelete && handleConfirmDelete(noteToDelete)}
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

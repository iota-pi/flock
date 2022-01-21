import {
  ChangeEvent,
  memo,
  MouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import makeStyles from '@mui/styles/makeStyles';
import {
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  Divider,
  IconButton,
  InputAdornment,
  ListItemIcon,
  Menu,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { CalendarPicker } from '@mui/lab';
import Visibility from '@mui/icons-material/Visibility';
import VisibilityOff from '@mui/icons-material/VisibilityOff';
import { CalendarIcon, DeleteIcon, MuiIconType, OptionsIcon } from './Icons';
import { compareNotes, getBlankNote, ItemId, ItemNote } from '../state/items';
import { formatDate, useToday } from '../utils';
import ConfirmationDialog from './dialogs/ConfirmationDialog';

const VISIBLE_NOTE_PAGE_SIZE = 5;
const MENU_POPUP_ID = 'note-control-menu-';
const CALENDAR_POPUP_ID = 'note-control-calendar-';

const useStyles = makeStyles(theme => ({
  noteDateContainer: {
    display: 'flex',
    alignItems: 'center',
  },
  noteDate: {
    padding: theme.spacing(1),
    paddingLeft: 0,
    color: theme.palette.text.disabled,
    fontWeight: theme.typography.caption.fontWeight,
    fontSize: theme.typography.caption.fontSize,
  },
}));

function NoteButton(
  {
    dataCy,
    disabled,
    label,
    onClick,
  }: {
    dataCy?: string,
    disabled?: boolean,
    label: string,
    onClick: () => void,
  },
) {
  return (
    <Button
      data-cy={dataCy}
      disabled={disabled}
      fullWidth
      onClick={onClick}
      size="small"
      variant="outlined"
    >
      {label}
    </Button>
  );
}

export interface MenuItemData {
  icon: MuiIconType,
  key: string,
  label: string,
  onClick: () => void,
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

  const [showMenu, setShowMenu] = useState(false);
  const [showSensitive, setShowSensitive] = useState(false);
  const [showCalendar, setShowCalendar] = useState(false);
  const [localContent, setLocalContent] = useState(note.content);
  const today = useToday();

  const menuAnchor = useRef<HTMLButtonElement>(null);

  useEffect(() => setLocalContent(note.content), [note.content]);
  useEffect(
    () => {
      const timeout = setTimeout(
        () => onChangeContent(note.id, localContent),
        100,
      );
      return () => clearTimeout(timeout);
    },
    [localContent, onChangeContent, note.id],
  );

  const handleClickMenu = useCallback(() => setShowMenu(o => !o), []);
  const handleCloseMenu = useCallback(() => setShowMenu(false), []);

  const handleChangeCompleted = useCallback(
    () => note.type === 'action' && onChangeCompleted(
      note.id,
      note.completed ? undefined : today.getTime(),
    ),
    [note, onChangeCompleted, today],
  );
  const handleChangeContent = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setLocalContent(event.target.value),
    [],
  );
  const handleChangeDate = useCallback(
    (date: Date | null) => {
      onChangeDate(note.id, date || today);
    },
    [note, onChangeDate, today],
  );
  const handleChangeSensitive = useCallback(
    () => {
      onChangeSensitive(note.id, !note.sensitive);
      setShowSensitive(true);
    },
    [note, onChangeSensitive],
  );

  const handleDelete = useCallback(
    () => {
      handleCloseMenu();
      onDelete(note);
    },
    [handleCloseMenu, note, onDelete],
  );
  const handleClickVisibility = useCallback(() => setShowSensitive(s => !s), []);
  const handleMouseDownVisibility = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => event.preventDefault(),
    [],
  );
  const handleClickCalendar = useCallback(() => setShowCalendar(true), []);
  const handleCloseCalendar = useCallback(() => setShowCalendar(false), []);

  const date = useMemo(() => new Date(note.date), [note.date]);

  const visible = !note.sensitive || showSensitive;

  return (
    <div>
      <Stack direction="row" alignItems="flex-end">
        <TextField
          autoFocus={autoFocus}
          disabled={!visible}
          fullWidth
          label={noteContentLabel}
          InputProps={{
            endAdornment: note.sensitive ? (
              <InputAdornment position="end">
                <IconButton
                  onClick={handleClickVisibility}
                  onMouseDown={handleMouseDownVisibility}
                >
                  {visible ? <Visibility /> : <VisibilityOff />}
                </IconButton>
              </InputAdornment>
            ) : null,
          }}
          multiline
          onChange={handleChangeContent}
          value={!visible ? '...' : localContent}
          variant="standard"
        />

        <IconButton
          aria-controls={`${MENU_POPUP_ID}-${note.id}`}
          aria-haspopup="true"
          onClick={handleClickMenu}
          ref={menuAnchor}
        >
          <OptionsIcon />
        </IconButton>

        <Menu
          anchorEl={menuAnchor.current}
          id={MENU_POPUP_ID}
          open={showMenu}
          anchorOrigin={{
            horizontal: 'right',
            vertical: 'bottom',
          }}
          transformOrigin={{
            horizontal: 'right',
            vertical: 'top',
          }}
          onClose={handleCloseMenu}
        >
          <MenuItem
            key="delete"
            onClick={handleDelete}
          >
            <ListItemIcon>
              <DeleteIcon />
            </ListItemIcon>

            Delete
          </MenuItem>

          <MenuItem
            key="sensitive"
            onClick={handleChangeSensitive}
          >
            <ListItemIcon>
              <Checkbox
                checked={note.sensitive || false}
                data-cy={`sensitive-note-${note.type}`}
                onChange={handleChangeSensitive}
                edge="start"
              />
            </ListItemIcon>

            Sensitive
          </MenuItem>

          {note.type === 'action' && (
            <MenuItem
              key="sensitive"
              onClick={handleChangeCompleted}
            >
              <Checkbox
                checked={!!note.completed}
                data-cy={`sensitive-note-${note.type}`}
                onChange={handleChangeCompleted}
              />

              Completed
            </MenuItem>
          )}
        </Menu>
      </Stack>

      <div className={`${classes.noteDateContainer}`}>
        <div className={classes.noteDate}>
          {formatDate(date)}
        </div>

        <IconButton
          aria-controls={`${CALENDAR_POPUP_ID}-${note.id}`}
          aria-haspopup="true"
          onClick={handleClickCalendar}
          size="small"
        >
          <CalendarIcon fontSize="small" />
        </IconButton>
      </div>

      <Dialog
        id={`${CALENDAR_POPUP_ID}-${note.id}`}
        open={showCalendar}
        onClose={handleCloseCalendar}
      >
        <CalendarPicker<Date | null>
          date={date as Date | null}
          onChange={handleChangeDate}
          minDate={note.type === 'action' ? today : undefined}
          maxDate={note.type === 'interaction' ? today : undefined}
        />

        <DialogActions>
          <Button
            fullWidth
            onClick={handleCloseCalendar}
            variant="outlined"
          >
            Done
          </Button>
        </DialogActions>
      </Dialog>

      <Divider />
    </div>
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
  const [visibleNotes, setVisibleNotes] = useState(VISIBLE_NOTE_PAGE_SIZE);

  const notesOfType = useMemo(
    () => rawNotes.filter(note => note.type === noteType).sort(compareNotes),
    [noteType, rawNotes],
  );
  const notes = useMemo(
    () => notesOfType.slice(0, visibleNotes),
    [notesOfType, visibleNotes],
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
  const handleShowMore = useCallback(
    () => setVisibleNotes(vn => vn + VISIBLE_NOTE_PAGE_SIZE),
    [],
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
  const hiddenNotes = Math.max(notesOfType.length - visibleNotes, 0);

  return (
    <Stack spacing={2}>
      <NoteButton
        dataCy={`add-${noteType}`}
        label={addNoteLabel}
        onClick={handleAddNote}
      />

      {notes.map(note => (
        <MemoSingleNote
          autoFocus={autoFocus === note.id}
          key={note.id}
          note={note}
          noteContentLabel={noteContentLabel}
          onChangeCompleted={handleChangeCompleted}
          onChangeContent={handleChangeContent}
          onChangeDate={handleChangeDate}
          onChangeSensitive={handleChangeSensitive}
          onDelete={handleDelete}
        />
      ))}

      {notes.length === 0 && noNotesText && (
        <div>{noNotesText}</div>
      )}

      {notes.length > 0 && (
        <NoteButton
          dataCy={`showMore-${noteType}`}
          disabled={hiddenNotes <= 0}
          label={`See more (${hiddenNotes})`}
          onClick={handleShowMore}
        />
      )}

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
    </Stack>
  );
}

export default NoteControl;

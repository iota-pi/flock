import { useCallback, useMemo, useState } from 'react'
import {
  Box,
  Button,
  Collapse,
  IconButton,
  List,
  ListItem,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material'
import {
  AddIcon,
  ArchiveIcon,
  CollapseIcon,
  DeleteIcon,
  ExpandIcon,
  NotesIcon,
  UnarchiveIcon,
} from './Icons'
import type { Note } from '../state/items'
import { formatDate, generateItemId } from '../utils'

interface Props {
  notes: Note[],
  onChange: (notes: Note[]) => void,
}

function NoteItem({
  note,
  onUpdate,
  onArchive,
  onDelete,
}: {
  note: Note
  onUpdate?: (id: string, text: string) => void
  onArchive: (id: string, archived: boolean) => void
  onDelete: (id: string) => void
}) {
  return (
    <ListItem disableGutters sx={{ alignItems: 'center' }}>
      <TextField
        fullWidth
        multiline
        minRows={note.archived ? undefined : 2}
        value={note.text}
        onChange={e => onUpdate?.(note.id, e.target.value)}
        disabled={note.archived}
        variant={note.archived ? 'filled' : 'outlined'}
        size="small"
        placeholder={note.archived ? undefined : "Write a note..."}
        hiddenLabel={note.archived}
        slotProps={{
          input: {
            endAdornment: (
              <Typography
                variant="caption"
                color="textSecondary"
                sx={{ position: 'absolute', bottom: 2, right: 8, pointerEvents: 'none' }}
              >
                {formatDate(new Date(note.created))}
              </Typography>
            ),
            sx: { pb: 3 },
          }
        }}
      />
      {(note.text.trim() || note.archived) && (
        <Tooltip title={note.archived ? "Unarchive Note" : "Archive Note"}>
          <IconButton onClick={() => onArchive(note.id, !note.archived)} size="small" sx={{ ml: 1 }}>
            {note.archived ? <UnarchiveIcon fontSize="small" /> : <ArchiveIcon fontSize="small" />}
          </IconButton>
        </Tooltip>
      )}
      {(note.archived || !note.text.trim()) && (
        <Tooltip title="Delete Note">
          <IconButton onClick={() => onDelete(note.id)} size="small" sx={{ ml: 1 }} color={note.archived ? "error" : "default"}>
            <DeleteIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      )}
    </ListItem>
  )
}

function NotesSection({
  notes,
  onChange,
}: Props) {
  const [showArchived, setShowArchived] = useState(false)

  const activeNotes = useMemo(
    () => (
      notes
        .filter(n => !n.archived)
        .sort((a, b) => b.created - a.created)
    ),
    [notes],
  )
  const archivedNotes = useMemo(
    () => (
      notes
        .filter(n => n.archived)
        .sort((a, b) => b.created - a.created)
    ),
    [notes],
  )

  const handleAddNote = useCallback(() => {
    const newNote: Note = {
      id: generateItemId(),
      text: '',
      archived: false,
      created: Date.now(),
    }
    onChange([newNote, ...notes])
  }, [notes, onChange])

  const handleUpdateNote = useCallback((id: string, text: string) => {
    onChange(notes.map(n => n.id === id ? { ...n, text } : n))
  }, [notes, onChange])

  const handleArchiveNote = useCallback((id: string, archived: boolean) => {
    onChange(notes.map(n => n.id === id ? { ...n, archived } : n))
  }, [notes, onChange])

  const handleDeleteNote = useCallback((id: string) => {
    onChange(notes.filter(n => n.id !== id))
  }, [notes, onChange])

  return (
    <Box width="100%">
      <Box display="flex" alignItems="center" justifyContent="space-between" mb={1}>
        <Box display="flex" alignItems="center">
          <NotesIcon color="action" sx={{ mr: 1 }} />
          <Typography variant="h6">Notes</Typography>
        </Box>
        <Button
          startIcon={<AddIcon />}
          onClick={handleAddNote}
          variant="outlined"
          size="small"
        >
          Add Note
        </Button>
      </Box>

      <List disablePadding>
        {activeNotes.map(note => (
          <NoteItem
            key={note.id}
            note={note}
            onUpdate={handleUpdateNote}
            onArchive={handleArchiveNote}
            onDelete={handleDeleteNote}
          />
        ))}
        {activeNotes.length === 0 && (
          <Typography variant="body2" color="textSecondary" sx={{ fontStyle: 'italic', py: 1 }}>
            No active notes
          </Typography>
        )}
      </List>

      {archivedNotes.length > 0 && (
        <Box mb={2}>
          <Button
            onClick={() => setShowArchived(!showArchived)}
            size="small"
            color="inherit"
            startIcon={showArchived ? <CollapseIcon /> : <ExpandIcon />}
          >
            {showArchived ? 'Hide' : 'Show'} Archived Notes ({archivedNotes.length})
          </Button>
          <Collapse in={showArchived}>
            <List disablePadding>
              {archivedNotes.map(note => (
                <NoteItem
                  key={note.id}
                  note={note}
                  onArchive={handleArchiveNote}
                  onDelete={handleDeleteNote}
                />
              ))}
            </List>
          </Collapse>
        </Box>
      )}
    </Box>
  )
}

export default NotesSection

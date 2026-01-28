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
  ArchiveIcon,
  NotesIcon,
  UnarchiveIcon,
} from './Icons'
import type { Note } from '../state/items'
import { generateItemId } from '../utils'

interface Props {
  notes: Note[],
  onChange: (notes: Note[]) => void,
}

function NotesSection({
  notes,
  onChange,
}: Props) {
  const [showArchived, setShowArchived] = useState(false)

  const activeNotes = useMemo(() => notes.filter(n => !n.archived).sort((a, b) => b.created - a.created), [notes])
  const archivedNotes = useMemo(() => notes.filter(n => n.archived).sort((a, b) => b.created - a.created), [notes])

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

  return (
    <Box width="100%">
      <Box display="flex" alignItems="center" justifyContent="space-between" mb={1}>
        <Box display="flex" alignItems="center">
          <NotesIcon color="action" sx={{ mr: 1 }} />
          <Typography variant="h6">Notes</Typography>
        </Box>
        <Button
          startIcon={<NotesIcon />}
          onClick={handleAddNote}
          variant="outlined"
          size="small"
        >
          Add Note
        </Button>
      </Box>

      <List disablePadding>
        {activeNotes.map(note => (
          <ListItem key={note.id} disableGutters sx={{ alignItems: 'flex-start' }}>
            <TextField
              fullWidth
              multiline
              minRows={2}
              value={note.text}
              onChange={e => handleUpdateNote(note.id, e.target.value)}
              variant="outlined"
              size="small"
              placeholder="Write a note..."
            />
            <Tooltip title="Archive Note">
              <IconButton onClick={() => handleArchiveNote(note.id, true)} size="small" sx={{ ml: 1, mt: 1 }}>
                <ArchiveIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </ListItem>
        ))}
        {activeNotes.length === 0 && (
          <Typography variant="body2" color="textSecondary" sx={{ fontStyle: 'italic', py: 1 }}>
            No active notes
          </Typography>
        )}
      </List>

      {archivedNotes.length > 0 && (
        <Box mt={2}>
          <Button
            onClick={() => setShowArchived(!showArchived)}
            size="small"
            color="inherit"
            startIcon={showArchived ? <UnarchiveIcon /> : <ArchiveIcon />}
          >
            {showArchived ? 'Hide' : 'Show'} Archived Notes ({archivedNotes.length})
          </Button>
          <Collapse in={showArchived}>
            <List disablePadding>
              {archivedNotes.map(note => (
                <ListItem key={note.id} disableGutters sx={{ alignItems: 'flex-start' }}>
                  <TextField
                    fullWidth
                    multiline
                    value={note.text}
                    disabled
                    variant="filled"
                    size="small"
                    sx={{ bgcolor: 'action.hover' }}
                  />
                  <Tooltip title="Unarchive Note">
                    <IconButton onClick={() => handleArchiveNote(note.id, false)} size="small" sx={{ ml: 1, mt: 1 }}>
                      <UnarchiveIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                </ListItem>
              ))}
            </List>
          </Collapse>
        </Box>
      )}
    </Box>
  )
}

export default NotesSection

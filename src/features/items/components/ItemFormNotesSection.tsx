import { Grid } from '@mui/material'
import type { Note } from '../../../state/items'
import NotesSection from '../../../components/NotesSection'

type ItemFormNotesSectionProps = {
  itemId: string
  notes: Note[]
  onChange: (notes: Note[]) => void
  disabled: boolean
}

export default function ItemFormNotesSection({
  itemId,
  notes,
  onChange,
  disabled,
}: ItemFormNotesSectionProps) {
  return (
    <Grid
      size={{ xs: 12 }}
      mt={1}
      sx={disabled ? { opacity: 0.5, pointerEvents: 'none' } : undefined}
    >
      <NotesSection
        key={itemId}
        notes={notes}
        onChange={onChange}
      />
    </Grid>
  )
}
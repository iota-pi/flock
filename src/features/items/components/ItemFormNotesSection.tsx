import { Grid } from '@mui/material'
import NotesSection from '../../../components/NotesSection'
import type { Note } from '../../../state/items'

type ItemFormNotesSectionProps = {
  notes: Note[]
  onChange: (notes: Note[]) => void
  itemId: string
  disabled: boolean
}

export default function ItemFormNotesSection({
  notes,
  onChange,
  itemId,
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
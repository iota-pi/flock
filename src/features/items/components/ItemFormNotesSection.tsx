import Grid from '@mui/material/Grid'

import NotesSection from 'src/components/NotesSection'
import type { ItemId, Note } from 'src/shared/schemas/items'


type ItemFormNotesSectionProps = {
  notes: Note[]
  onChange: (notes: Note[]) => void
  itemId: ItemId
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
      sx={[
        { mt: 1 },
        disabled ? { opacity: 0.5, pointerEvents: 'none' } : {},
      ]}
    >
      <NotesSection
        key={itemId}
        notes={notes}
        onChange={onChange}
      />
    </Grid>
  )
}
import { Grid } from '@mui/material'
import { useController, useFormContext } from 'react-hook-form'
import NotesSection from '../../../components/NotesSection'
import type { ItemFormDraftValues } from './itemFormValues'

type ItemFormNotesSectionProps = {
  itemId: string
  disabled: boolean
}

export default function ItemFormNotesSection({
  itemId,
  disabled,
}: ItemFormNotesSectionProps) {
  const { control } = useFormContext<ItemFormDraftValues>()
  const { field } = useController({
    control,
    name: 'notes',
  })

  return (
    <Grid
      size={{ xs: 12 }}
      mt={1}
      sx={disabled ? { opacity: 0.5, pointerEvents: 'none' } : undefined}
    >
      <NotesSection
        key={itemId}
        notes={field.value}
        onChange={field.onChange}
      />
    </Grid>
  )
}
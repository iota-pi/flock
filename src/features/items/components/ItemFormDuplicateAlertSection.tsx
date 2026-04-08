import { Collapse, Grid } from '@mui/material'
import type { Item } from '../../../state/items'
import DuplicateAlert from '../../../components/drawers/utils/DuplicateAlert'

type ItemFormDuplicateAlertSectionProps = {
  duplicateCount: number
  hasDescription: boolean
  itemType: Item['type']
}

export default function ItemFormDuplicateAlertSection({
  duplicateCount,
  hasDescription,
  itemType,
}: ItemFormDuplicateAlertSectionProps) {
  return (
    <Grid size={{ xs: 12 }} mt={-1}>
      <Collapse in={duplicateCount > 0}>
        <DuplicateAlert
          count={duplicateCount}
          hasDescription={hasDescription}
          itemType={itemType}
        />
      </Collapse>
    </Grid>
  )
}
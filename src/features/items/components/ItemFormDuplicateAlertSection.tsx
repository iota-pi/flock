import { Collapse, Grid } from '@mui/material'
import { ERROR_ITEM_TYPE, type Item } from '../../../state/items'
import type { ItemType } from '../../../shared/itemTypes'
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
  const showDuplicateAlert = itemType !== ERROR_ITEM_TYPE
  const normalizedType: ItemType = showDuplicateAlert ? itemType : 'person'

  return (
    <Grid size={{ xs: 12 }} mt={-1}>
      <Collapse in={showDuplicateAlert && duplicateCount > 0}>
        <DuplicateAlert
          count={duplicateCount}
          hasDescription={hasDescription}
          itemType={normalizedType}
        />
      </Collapse>
    </Grid>
  )
}
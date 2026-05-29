import { useMemo } from 'react'
import Collapse from '@mui/material/Collapse'
import Grid from '@mui/material/Grid'

import { getItemName, type Item } from 'src/state/items'
import { ERROR_ITEM_TYPE, type ItemType } from 'src/shared/itemTypes'
import DuplicateAlert from 'src/components/drawers/utils/DuplicateAlert'
import { useVisibleItems } from 'src/state/selectors'


type ItemFormDuplicateAlertSectionProps = {
  hasDescription: boolean
  itemId: string
  itemType: Item['type']
  nameValue: string
}

export default function ItemFormDuplicateAlertSection({
  hasDescription,
  itemId,
  itemType,
  nameValue,
}: ItemFormDuplicateAlertSectionProps) {
  const allItems = useVisibleItems()
  const targetName = getItemName({ name: nameValue, type: itemType })
  const duplicates = useMemo(
    () => allItems.filter(i => i.type === itemType && i.id !== itemId && getItemName(i) === targetName),
    [allItems, itemType, itemId, targetName],
  )

  const showDuplicateAlert = itemType !== ERROR_ITEM_TYPE
  const normalizedType: ItemType = showDuplicateAlert ? itemType : 'person'
  const duplicateCount = duplicates.length

  return (
    <Grid size={{ xs: 12 }} sx={{
      mt: -1
    }}>
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
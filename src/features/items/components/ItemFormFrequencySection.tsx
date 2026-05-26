import { useCallback } from 'react'
import { Grid } from '@mui/material'
import type { Item } from 'src/state/items'
import FrequencyControls from 'src/components/FrequencyControls'
import CollapsibleSection from 'src/components/drawers/utils/CollapsibleSection'
import { FrequencyIcon } from 'src/components/Icons'
import { getLastPrayedFor } from 'src/utils/prayer'
import { GroupItem } from 'src/shared/schemas/items'
import { useGroupLookupMap } from 'src/state/selectors'

type FrequencyUpdate = Partial<Pick<Item, 'prayerFrequency'>>
  & Partial<Pick<GroupItem, 'memberPrayerFrequency' | 'memberPrayerTarget'>>

type ItemFormFrequencySectionProps = {
  defaultExpandAccordions: boolean
  disabled: boolean
  item: Item
  onChange: (data: FrequencyUpdate) => void
}

export default function ItemFormFrequencySection({
  defaultExpandAccordions,
  disabled,
  item,
  onChange,
}: ItemFormFrequencySectionProps) {
  const handleChange = useCallback(
    (data: FrequencyUpdate) => onChange(data),
    [onChange],
  )
  const groupLookup = useGroupLookupMap()

  const lastPrayer = getLastPrayedFor(item)
  const memberFrequency = item.type === 'group'
    ? item.memberPrayerFrequency
    : undefined
  const memberTarget = item.type === 'group'
    ? item.memberPrayerTarget
    : undefined
  const partOfGroups = item.type === 'person'
    ? groupLookup.get(item.id)?.groupIds ?? []
    : []

  return (
    <Grid size={{ xs: 12 }}>
      <CollapsibleSection
        content={item.type === 'group' ? (
          <FrequencyControls
            id={item.id}
            lastPrayer={lastPrayer}
            onChange={handleChange}
            prayerFrequency={item.prayerFrequency}
            memberPrayerFrequency={memberFrequency!}
            memberPrayerTarget={memberTarget!}
          />
        ) : (
          <FrequencyControls
            id={item.id}
            lastPrayer={lastPrayer}
            onChange={handleChange}
            prayerFrequency={item.prayerFrequency}
            partOfGroups={partOfGroups!}
          />
        )}
        disabled={disabled}
        icon={FrequencyIcon}
        id="frequency"
        initialExpanded={defaultExpandAccordions}
        title="Prayer Frequency"
      />
    </Grid>
  )
}
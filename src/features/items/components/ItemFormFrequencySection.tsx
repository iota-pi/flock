import { useCallback } from 'react'
import { Grid } from '@mui/material'
import type { Item, LocalChangeItem } from '../../../state/items'
import FrequencyControls from '../../../components/FrequencyControls'
import CollapsibleSection from '../../../components/drawers/utils/CollapsibleSection'
import { FrequencyIcon } from '../../../components/Icons'
import { getLastPrayedFor } from '../../../utils/prayer'
import { GroupItem } from 'src/shared/schemas/items'
import { useGroupLookupMap } from '../../../state/selectors'

type FrequencyUpdate = Partial<Pick<Item, 'prayerFrequency'>>
  & Partial<Pick<GroupItem, 'memberPrayerFrequency' | 'memberPrayerTarget'>>

type ItemFormFrequencySectionProps = {
  defaultExpandAccordions: boolean
  disabled: boolean
  item: LocalChangeItem<Item>
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
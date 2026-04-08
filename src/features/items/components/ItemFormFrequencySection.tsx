import { Grid } from '@mui/material'
import type { DirtyItem, Item } from '../../../state/items'
import FrequencyControls from '../../../components/FrequencyControls'
import CollapsibleSection from '../../../components/drawers/utils/CollapsibleSection'
import { FrequencyIcon } from '../../../components/Icons'
import { getLastPrayedFor } from '../../../utils/prayer'

type ItemFormFrequencySectionProps = {
  defaultExpandAccordions: boolean
  disabled: boolean
  item: DirtyItem<Item>
  onChange: <T extends Item>(data: Partial<T> | ((prev: Item) => Item)) => void
}

export default function ItemFormFrequencySection({
  defaultExpandAccordions,
  disabled,
  item,
  onChange,
}: ItemFormFrequencySectionProps) {
  const lastPrayer = getLastPrayedFor(item)
  const memberFrequency = item.type === 'group' ? item.memberPrayerFrequency : undefined
  const memberTarget = item.type === 'group' ? item.memberPrayerTarget : undefined

  return (
    <Grid size={{ xs: 12 }}>
      <CollapsibleSection
        content={(
          <FrequencyControls
            id={item.id}
            lastPrayer={lastPrayer}
            onChange={onChange}
            prayerFrequency={item.prayerFrequency}
            memberPrayerFrequency={memberFrequency}
            memberPrayerTarget={memberTarget}
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
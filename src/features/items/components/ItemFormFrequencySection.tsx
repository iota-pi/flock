import { useCallback } from 'react'
import { Grid } from '@mui/material'
import { useFormContext, useWatch } from 'react-hook-form'
import type { DirtyItem, GroupItem, Item } from '../../../state/items'
import FrequencyControls from '../../../components/FrequencyControls'
import CollapsibleSection from '../../../components/drawers/utils/CollapsibleSection'
import { FrequencyIcon } from '../../../components/Icons'
import { getLastPrayedFor } from '../../../utils/prayer'
import type { ItemFormDraftValues } from './itemFormValues'

type FrequencyUpdate = Partial<Pick<Item, 'prayerFrequency'>>
  & Partial<Pick<GroupItem, 'memberPrayerFrequency' | 'memberPrayerTarget'>>

type ItemFormFrequencySectionProps = {
  defaultExpandAccordions: boolean
  disabled: boolean
  item: DirtyItem<Item>
}

export default function ItemFormFrequencySection({
  defaultExpandAccordions,
  disabled,
  item,
}: ItemFormFrequencySectionProps) {
  const { setValue } = useFormContext<ItemFormDraftValues>()
  const prayerFrequency = useWatch({ name: 'prayerFrequency' })
  const memberPrayerFrequency = useWatch({ name: 'memberPrayerFrequency' })
  const memberPrayerTarget = useWatch({ name: 'memberPrayerTarget' })

  const handleChange = useCallback(
    (data: FrequencyUpdate) => {
      if (data.prayerFrequency !== undefined) {
        setValue('prayerFrequency', data.prayerFrequency, { shouldDirty: true })
      }

      if (data.memberPrayerFrequency !== undefined) {
        setValue('memberPrayerFrequency', data.memberPrayerFrequency, { shouldDirty: true })
      }

      if (data.memberPrayerTarget !== undefined) {
        setValue('memberPrayerTarget', data.memberPrayerTarget, { shouldDirty: true })
      }
    },
    [setValue],
  )

  const lastPrayer = getLastPrayedFor(item)
  const memberFrequency = item.type === 'group'
    ? (memberPrayerFrequency ?? item.memberPrayerFrequency)
    : undefined
  const memberTarget = item.type === 'group'
    ? (memberPrayerTarget ?? item.memberPrayerTarget)
    : undefined

  return (
    <Grid size={{ xs: 12 }}>
      <CollapsibleSection
        content={(
          <FrequencyControls
            id={item.id}
            lastPrayer={lastPrayer}
            onChange={handleChange}
            prayerFrequency={prayerFrequency ?? item.prayerFrequency}
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
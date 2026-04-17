import { useCallback, useMemo } from 'react'
import { Grid } from '@mui/material'
import type { DirtyItem, GroupItem, Item } from '../../../state/items'
import { useFormContext, useWatch } from 'react-hook-form'
import CollapsibleSection from '../../../components/drawers/utils/CollapsibleSection'
import GroupDisplay from '../../groups/components/GroupDisplay'
import MemberDisplay from '../../groups/components/MemberDisplay'
import { GroupIcon, PersonIcon } from '../../../components/Icons'
import type { ItemFormDraftValues } from './itemFormValues'

type ItemFormRelationshipsSectionProps = {
  defaultExpandAccordions: boolean
  item: DirtyItem<Item>
}

export default function ItemFormRelationshipsSection({
  defaultExpandAccordions,
  item,
}: ItemFormRelationshipsSectionProps) {
  const { setValue } = useFormContext<ItemFormDraftValues>()
  const name = useWatch({ name: 'name' })
  const members = useWatch({ name: 'members' })

  const group = useMemo(
    () => {
      if (item.type !== 'group') {
        return undefined
      }

      return {
        ...(item as GroupItem),
        members: members ?? item.members,
        name: name ?? item.name,
      }
    },
    [item, members, name],
  )

  const handleMembersChange = useCallback(
    (nextGroup: Partial<Pick<GroupItem, 'members'>>) => {
      setValue('members', nextGroup.members ?? [], { shouldDirty: true })
    },
    [setValue],
  )

  return (
    <Grid size={{ xs: 12 }}>
      {group && (
        <CollapsibleSection
          content={(
            <MemberDisplay
              group={group}
              memberIds={group.members}
              onChange={handleMembersChange}
            />
          )}
          icon={PersonIcon}
          id="members"
          initialExpanded={defaultExpandAccordions}
          title="Members"
        />
      )}

      {item.type === 'person' && (
        <CollapsibleSection
          content={<GroupDisplay itemId={item.id} />}
          icon={GroupIcon}
          id="groups"
          initialExpanded={defaultExpandAccordions}
          title="Groups"
        />
      )}
    </Grid>
  )
}
import { useCallback, useMemo } from 'react'
import Grid from '@mui/material/Grid'

import type { Item } from 'src/state/items'
import CollapsibleSection from 'src/components/drawers/utils/CollapsibleSection'
import GroupDisplay from '../../groups/components/GroupDisplay'
import MemberDisplay from '../../groups/components/MemberDisplay'
import { GroupIcon, PersonIcon } from 'src/components/Icons'
import { GroupItem } from 'src/shared/schemas/items'


type ItemFormRelationshipsSectionProps = {
  defaultExpandAccordions: boolean
  item: Item
  onChange: (data: Partial<Pick<GroupItem, 'members'>>) => void
}

export default function ItemFormRelationshipsSection({
  defaultExpandAccordions,
  item,
  onChange,
}: ItemFormRelationshipsSectionProps) {
  const group = useMemo(
    () => {
      if (item.type !== 'group') {
        return undefined
      }

      return {
        ...(item as GroupItem),
      }
    },
    [item],
  )

  const handleMembersChange = useCallback(
    (nextGroup: Partial<Pick<GroupItem, 'members'>>) => {
      onChange({ members: nextGroup.members ?? [] })
    },
    [onChange],
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
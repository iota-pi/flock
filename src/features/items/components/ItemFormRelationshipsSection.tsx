import { Grid } from '@mui/material'
import type { DirtyItem, GroupItem, Item } from '../../../state/items'
import CollapsibleSection from '../../../components/drawers/utils/CollapsibleSection'
import GroupDisplay from '../../groups/components/GroupDisplay'
import MemberDisplay from '../../groups/components/MemberDisplay'
import { GroupIcon, PersonIcon } from '../../../components/Icons'

type ItemFormRelationshipsSectionProps = {
  defaultExpandAccordions: boolean
  item: DirtyItem<Item>
  onChange: <T extends Item>(data: Partial<T> | ((prev: Item) => Item)) => void
}

export default function ItemFormRelationshipsSection({
  defaultExpandAccordions,
  item,
  onChange,
}: ItemFormRelationshipsSectionProps) {
  const members = item.type === 'group' ? item.members : undefined

  return (
    <Grid size={{ xs: 12 }}>
      {members !== undefined && (
        <CollapsibleSection
          content={(
            <MemberDisplay
              group={item as GroupItem}
              memberIds={members}
              onChange={group => onChange<GroupItem>(group)}
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
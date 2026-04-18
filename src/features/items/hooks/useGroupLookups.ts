import { useMemo } from 'react'
import { type GroupItem } from '../../../state/items'
import { type ItemId } from '../../../shared/itemTypes'
import { useItems } from '../../../state/selectors'

export interface GroupLookupData {
  tags: string[]
  groupIds: ItemId[]
}

export function useGroupLookups(): ReadonlyMap<ItemId, GroupLookupData> {
  const allGroups = useItems<GroupItem>('group')

  return useMemo(() => {
    const lookup = new Map<ItemId, GroupLookupData>()
    for (const group of allGroups) {
      if (group.archived) {
        continue
      }

      const members = Array.isArray(group.members) ? group.members : []
      for (const memberId of members) {
        const existing = lookup.get(memberId)
        if (existing) {
          existing.tags.push(group.name)
          existing.groupIds.push(group.id)
        } else {
          lookup.set(memberId, {
            tags: [group.name],
            groupIds: [group.id],
          })
        }
      }
    }
    return lookup
  }, [allGroups])
}

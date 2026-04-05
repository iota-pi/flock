import { useMemo } from 'react'
import { type GroupItem } from '../../../state/items'
import { useItems } from '../../../state/selectors'

export function useGroupLookups(): ReadonlyMap<string, GroupItem[]> {
  const allGroups = useItems('group') as GroupItem[]

  return useMemo(() => {
    const lookup = new Map<string, GroupItem[]>()
    for (const group of allGroups) {
      const members = Array.isArray(group.members) ? group.members : []
      for (const memberId of members) {
        const existing = lookup.get(memberId)
        if (existing) {
          existing.push(group)
        } else {
          lookup.set(memberId, [group])
        }
      }
    }
    return lookup
  }, [allGroups])
}

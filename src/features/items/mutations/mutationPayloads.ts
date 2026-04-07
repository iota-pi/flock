import type { ItemId } from '../../../shared/itemTypes'
import { type GroupItem, type Item } from '../../../state/items'

export function dedupeItemsById(items: Item | Item[]): Item[] {
  const incoming = Array.isArray(items) ? items : [items]
  const deduped = new Map<ItemId, Item>()

  for (const item of incoming) {
    deduped.set(item.id, item)
  }

  return Array.from(deduped.values())
}

function removeMembersFromGroup(group: GroupItem, idsSet: Set<ItemId>): GroupItem {
  return {
    ...group,
    members: group.members.filter(memberId => !idsSet.has(memberId)),
  }
}

export function updateGroupsForDeletedMembers(allItems: Item[], idsSet: Set<ItemId>): GroupItem[] {
  return allItems
    .filter((item): item is GroupItem => (
      item.type === 'group' && item.members.some(memberId => idsSet.has(memberId))
    ))
    .map(group => removeMembersFromGroup(group, idsSet))
}

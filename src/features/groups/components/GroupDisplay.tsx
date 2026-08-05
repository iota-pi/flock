import { useCallback, useMemo } from 'react'

import type { Item } from 'src/state/items'
import { useGroupLookupMap } from 'src/state/selectors'
import ItemList from '../../items/components/ItemList'
import { mutateItem } from '../../items/mutations/itemMutations'
import Search from 'src/components/Search'
import { useAppStore } from 'src/state/store'
import type { GroupItem, ItemId } from 'src/shared/schemas/items'
import { RemoveIcon } from 'src/components/Icons'

interface Props {
  editable?: boolean,
  itemId: ItemId,
}


function GroupDisplay({
  editable = true,
  itemId,
}: Props) {
  const groupLookupMap = useGroupLookupMap()
  const setDrawer = useAppStore(state => state.setDrawer)

  const currentGroups = useMemo(
    () => groupLookupMap.get(itemId)?.groupIds || [],
    [groupLookupMap, itemId],
  )

  const handleSelect = useCallback(
    (group: GroupItem) => {
      const members = [...group.members, itemId]

      void mutateItem(group.id, { members }).catch(error => {
        console.error(error)
      })
    },
    [itemId],
  )
  const handleRemove = useCallback(
    (item: Item) => {
      const group = item as GroupItem
      const members = group.members.filter(m => m !== itemId)

      void mutateItem(group.id, { members }).catch(error => {
        console.error(error)
      })
    },
    [itemId],
  )
  const handleClickItem = useCallback(
    (item: Item) => {
      setDrawer({ item: item.id })
    },
    [setDrawer],
  )

  const getActionIcon = useCallback(
    () => editable ? <RemoveIcon /> : undefined,
    [editable],
  )

  return (
    <>
      {editable && (
        <Search<GroupItem>
          dataCy="groups"
          label="Add to group"
          noItemsText="No groups found"
          onSelect={handleSelect}
          onRemove={handleRemove}
          selectedItemIds={currentGroups}
          types={{ group: true }}
          searchDescription
          showIcons={false}
          showOptionCheckboxes
          showSelectedOptions
        />
      )}

      <ItemList
        compact
        dividers
        fullHeight={false}
        getActionIcon={getActionIcon}
        itemIds={currentGroups}
        noItemsHint="Not in any groups"
        onClick={handleClickItem}
        onClickAction={editable ? handleRemove : undefined}
        paddingBottom={0}
        showIcons
      />
    </>
  )
}

export default GroupDisplay

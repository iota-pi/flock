import { useCallback, useMemo } from 'react'
import DeleteIcon from '@mui/icons-material/Close'
import type { Item } from 'src/state/items'
import type { ItemId } from 'src/shared/itemTypes'
import { useGroupLookupMap } from 'src/state/selectors'
import ItemList from '../../items/components/ItemList'
import { mutateItem } from '../../items/mutations/itemMutations'
import Search from 'src/components/Search'
import { useNavigationStore } from 'src/state/navigationStore'
import { GroupItem } from 'src/shared/schemas/items'

interface Props {
  editable?: boolean,
  itemId: ItemId,
}


function GroupDisplay({
  editable = true,
  itemId,
}: Props) {
  const groupLookupMap = useGroupLookupMap()
  const setDrawer = useNavigationStore(state => state.setDrawer)

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
    () => editable ? <DeleteIcon /> : undefined,
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

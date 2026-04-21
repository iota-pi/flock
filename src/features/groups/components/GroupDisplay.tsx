import { useCallback, useMemo } from 'react'
import DeleteIcon from '@mui/icons-material/Close'
import type { GroupItem, Item } from '../../../state/items'
import type { ItemId } from '../../../shared/itemTypes'
import { useItemIds, useItemsById } from '../../../state/selectors'
import ItemList from '../../items/components/ItemList'
import { storeItems } from '../../items/mutations/itemMutations'
import Search from '../../../components/Search'
import { useNavigationStore } from '../../../state/navigationStore'
import { useAutomergeItemsById } from '../../../sync/useAutomerge'

interface Props {
  editable?: boolean,
  itemId: ItemId,
}


function GroupDisplay({
  editable = true,
  itemId,
}: Props) {
  const allGroupIds = useItemIds('group')
  const getItemsById = useItemsById()
  const pushActive = useNavigationStore(state => state.pushActive)
  
  const currentGroupIds = useMemo(
    () => {
      const groups = getItemsById<GroupItem>(allGroupIds)
      return groups.filter(g => g.members.includes(itemId)).map(g => g.id)
    },
    [allGroupIds, getItemsById, itemId],
  )

  const currentGroups = useAutomergeItemsById<GroupItem>(currentGroupIds)

  const handleSelect = useCallback(
    (group: GroupItem) => {
      const newGroup: GroupItem = {
        ...group,
        members: [...group.members, itemId],
      }

      void storeItems(newGroup).catch(error => {
        console.error(error)
      })
    },
    [itemId],
  )
  const handleRemove = useCallback(
    (group: Item) => {
      const g = group as GroupItem
      const newGroup: GroupItem = {
        ...g,
        members: g.members.filter(m => m !== itemId),
      }

      void storeItems(newGroup).catch(error => {
        console.error(error)
      })
    },
    [itemId],
  )
  const handleClickGroup = useCallback(
    (group: Item) => {
      pushActive({ item: group.id })
    },
    [pushActive],
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
          selectedItems={currentGroups}
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
        getActionIcon={editable ? () => <DeleteIcon /> : undefined}
        itemIds={currentGroupIds}
        noItemsHint="Not in any groups"
        onClick={handleClickGroup}
        onClickAction={editable ? handleRemove : undefined}
        paddingBottom={0}
        showIcons
      />
    </>
  )
}

export default GroupDisplay

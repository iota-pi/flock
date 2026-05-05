import { useCallback, useMemo } from 'react'
import DeleteIcon from '@mui/icons-material/Close'
import type { Item } from '../../../state/items'
import type { ItemId } from '../../../shared/itemTypes'
import { useItemIds, useItemsByIds } from '../../../state/selectors'
import ItemList from '../../items/components/ItemList'
import { mutateItem } from '../../items/mutations/itemMutations'
import Search from '../../../components/Search'
import { useNavigationStore } from '../../../state/navigationStore'
import { GroupItem } from 'src/shared/schemas/items'

interface Props {
  editable?: boolean,
  itemId: ItemId,
}


function GroupDisplay({
  editable = true,
  itemId,
}: Props) {
  const allGroupIds = useItemIds('group')
  const allGroups = useItemsByIds<GroupItem>(allGroupIds)
  const setDrawer = useNavigationStore(state => state.setDrawer)

  const currentGroups = useMemo(
    () => allGroups.filter(g => g.members.includes(itemId)),
    [allGroups, itemId],
  )

  const currentGroupIds = useMemo(
    () => currentGroups.map(g => g.id),
    [currentGroups],
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
        onClick={handleClickItem}
        onClickAction={editable ? handleRemove : undefined}
        paddingBottom={0}
        showIcons
      />
    </>
  )
}

export default GroupDisplay

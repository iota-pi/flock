import { useCallback, useMemo } from 'react'
import DeleteIcon from '@mui/icons-material/Close'
import { GroupItem, ItemId } from '../state/items'
import { useItems } from '../state/selectors'
import ItemList from './ItemList'
import { useAppDispatch } from '../store'
import { pushActive } from '../state/ui'
import { useStoreItemsMutation } from '../api/queries'
import Search from './Search'

export interface Props {
  editable?: boolean,
  itemId: ItemId,
}


function GroupDisplay({
  editable = true,
  itemId,
}: Props) {
  const allGroups = useItems<GroupItem>('group')
  const dispatch = useAppDispatch()
  const { mutate: storeItems } = useStoreItemsMutation()

  const currentGroups = useMemo(
    () => allGroups.filter(g => g.members.includes(itemId)),
    [allGroups, itemId],
  )

  const handleSelect = useCallback(
    (group: GroupItem) => {
      const newGroup: GroupItem = {
        ...group,
        members: [...group.members, itemId],
      }
      storeItems(newGroup)
    },
    [itemId, storeItems],
  )
  const handleRemove = useCallback(
    (group: GroupItem) => {
      const newGroup: GroupItem = {
        ...group,
        members: group.members.filter(m => m !== itemId),
      }
      storeItems(newGroup)
    },
    [itemId, storeItems],
  )
  const handleClickGroup = useCallback(
    (group: GroupItem) => {
      dispatch(pushActive({ item: group.id }))
    },
    [dispatch],
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
        items={currentGroups}
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

import { useCallback, useMemo } from 'react'
import DeleteIcon from '@mui/icons-material/Close'
import type { GroupItem } from '../state/items'
import type { ItemId } from '../shared/itemTypes'
import { useItems } from '../state/selectors'
import ItemList from './ItemList'
import { mutateStoreItems } from '../api/clientMutations'
import Search from './Search'
import { useUiStore } from '../state/uiStore'

export interface Props {
  editable?: boolean,
  itemId: ItemId,
}


function GroupDisplay({
  editable = true,
  itemId,
}: Props) {
  const allGroups = useItems<GroupItem>('group')
  const pushActive = useUiStore(state => state.pushActive)
  const storeItems = mutateStoreItems

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

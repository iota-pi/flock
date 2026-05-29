import {
  useCallback,
  useMemo,
} from 'react'

import type { Item } from 'src/state/items'
import type { ItemId } from 'src/shared/itemTypes'
import { useItemsByIds, useSortCriteria } from 'src/state/selectors'
import ItemList from '../../items/components/ItemList'
import { sortItems } from 'src/utils/customSort'
import Search from 'src/components/Search'
import { useNavigationStore } from 'src/state/navigationStore'
import { GroupItem, PersonItem } from 'src/shared/schemas/items'
import { RemoveIcon } from 'src/components/Icons'


interface Props {
  editable?: boolean,
  group: GroupItem,
  memberIds: ItemId[],
  onChange: (item: Partial<Pick<GroupItem, 'members'>>) => void,
}

function MemberDisplay({
  editable = true,
  group,
  memberIds,
  onChange,
}: Props) {
  const setDrawer = useNavigationStore(state => state.setDrawer)
  const [sortCriteria] = useSortCriteria()

  const unsortedMembers = useItemsByIds<PersonItem>(memberIds)

  const members = useMemo(
    () => sortItems(unsortedMembers, sortCriteria),
    [unsortedMembers, sortCriteria],
  )

  const sortedMemberIds = useMemo(
    () => members.map(m => m.id),
    [members],
  )

  const handleClickItem = useCallback(
    (item: Item) => {
      setDrawer({ item: item.id })
    },
    [setDrawer],
  )
  const handleSelect = useCallback(
    (item: Item) => {
      onChange({ members: [...memberIds, item.id] })
    },
    [memberIds, onChange],
  )
  const handleRemove = useCallback(
    (item: Item) => {
      onChange({ members: memberIds.filter(m => m !== item.id) })
    },
    [memberIds, onChange],
  )

  const groupName = group?.name
  const filterTags = useCallback(
    (tag: string) => !groupName || groupName !== tag,
    [groupName],
  )

  const getActionIcon = useCallback(
    () => editable ? <RemoveIcon /> : undefined,
    [editable],
  )

  return (
    <>
      {editable && (
        <Search<PersonItem>
          dataCy="members"
          label="Add group members"
          noItemsText="No people found"
          onSelect={handleSelect}
          onRemove={handleRemove}
          selectedItemIds={sortedMemberIds}
          types={{ person: true }}
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
        itemIds={sortedMemberIds}
        noItemsHint="No group members"
        onClick={handleClickItem}
        onClickAction={editable ? handleRemove : undefined}
        paddingBottom={0}
        showIcons
        filterTags={filterTags}
      />
    </>
  )
}

export default MemberDisplay

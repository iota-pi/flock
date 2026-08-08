import {
  useCallback,
  useMemo,
} from 'react'

import type { Item } from 'src/state/items'
import { useItemsByIds, useSortCriteria } from 'src/state/selectors'
import ItemList from '../../items/components/ItemList'
import { sortItems } from 'src/utils/customSort'
import Search from 'src/components/Search'
import { useAppStore } from 'src/state/store'
import type { GroupItem, ItemId, PersonItem, TopicItem } from 'src/shared/schemas/items'
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
  const setDrawer = useAppStore(state => state.setDrawer)
  const [sortCriteria] = useSortCriteria()

  const unsortedMembers = useItemsByIds<PersonItem | TopicItem>(memberIds)

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
        <Search<PersonItem | TopicItem>
          dataCy="members"
          label="Add group members"
          noItemsText="No people or topics found"
          onSelect={handleSelect}
          onRemove={handleRemove}
          selectedItemIds={sortedMemberIds}
          types={{ person: true, topic: true }}
          searchDescription
          showIcons
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

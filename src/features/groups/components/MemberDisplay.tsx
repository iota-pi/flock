import {
  useCallback,
  useMemo,
} from 'react'
import DeleteIcon from '@mui/icons-material/Close'
import type { GroupItem, Item, PersonItem } from '../../../state/items'
import type { ItemId } from '../../../shared/itemTypes'
import { useItemsById, useSortCriteria } from '../../../state/selectors'
import ItemList from '../../items/components/ItemList'
import { sortItems } from '../../../utils/customSort'
import Search from '../../../components/Search'
import { useNavigationStore } from '../../../state/navigationStore'
import { useAutomergeItemsById } from '../../../sync/useAutomerge'


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
  const pushActive = useNavigationStore(state => state.pushActive)
  const getItemsById = useItemsById()
  const [sortCriteria] = useSortCriteria()

  const sortedMemberIds = useMemo(
    () => sortItems(getItemsById<PersonItem>(memberIds), sortCriteria).map(m => m.id),
    [getItemsById, memberIds, sortCriteria],
  )
  const members = useAutomergeItemsById(sortedMemberIds)

  const handleClickItem = useCallback(
    (item: Item) => {
      pushActive({ item: item.id })
    },
    [pushActive],
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

  return (
    <>
      {editable && (
        <Search<PersonItem>
          dataCy="members"
          label="Add group members"
          noItemsText="No people found"
          onSelect={handleSelect}
          onRemove={handleRemove}
          selectedItems={members as PersonItem[]}
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
        getActionIcon={editable ? () => <DeleteIcon /> : undefined}
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

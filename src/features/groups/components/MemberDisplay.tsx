import {
  useCallback,
  useMemo,
} from 'react'
import DeleteIcon from '@mui/icons-material/Close'
import type { Item } from '../../../state/items'
import type { ItemId } from '../../../shared/itemTypes'
import { useItemsByIds, useSortCriteria } from '../../../state/selectors'
import ItemList from '../../items/components/ItemList'
import { sortItems } from '../../../utils/customSort'
import Search from '../../../components/Search'
import { useNavigationStore } from '../../../state/navigationStore'
import { GroupItem, PersonItem } from 'src/shared/schemas/items'


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
    () => editable ? <DeleteIcon /> : undefined,
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

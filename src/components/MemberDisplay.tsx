import {
  useCallback,
  useMemo,
} from 'react'
import DeleteIcon from '@mui/icons-material/Close'
import { GroupItem, Item, ItemId, PersonItem } from '../state/items'
import { useItemsById, useSortCriteria } from '../state/selectors'
import ItemList from './ItemList'
import { sortItems } from '../utils/customSort'
import Search from './Search'
import { useUiStore } from '../state/uiStore'


export interface Props {
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
  const pushActive = useUiStore(state => state.pushActive)
  const getItemsById = useItemsById()
  const [sortCriteria] = useSortCriteria()

  const members = useMemo(
    () => sortItems(getItemsById<PersonItem>(memberIds), sortCriteria),
    [getItemsById, memberIds, sortCriteria],
  )

  const handleClickItem = useCallback(
    (item: PersonItem) => {
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
          selectedItems={members}
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
        items={members}
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

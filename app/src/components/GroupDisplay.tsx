import {
  useCallback,
  useMemo,
} from 'react';
import DeleteIcon from '@mui/icons-material/Close';
import { GroupItem, ItemId } from '../state/items';
import { useItems, useVault } from '../state/selectors';
import ItemList from './ItemList';
import { useAppDispatch } from '../store';
import { pushActive } from '../state/ui';
import Search from './Search';


export interface Props {
  editable?: boolean,
  itemId: ItemId,
}


function GroupDisplay({
  editable = true,
  itemId,
}: Props) {
  const allGroups = useItems<GroupItem>('group');
  const dispatch = useAppDispatch();
  const vault = useVault();

  const currentGroups = useMemo(
    () => allGroups.filter(g => g.members.includes(itemId)),
    [allGroups, itemId],
  );

  const handleSelectGroup = useCallback(
    (group: GroupItem) => {
      const newGroup: GroupItem = {
        ...group,
        members: [...group.members, itemId],
      };
      vault?.store(newGroup);
    },
    [itemId, vault],
  );
  const handleRemoveGroup = useCallback(
    (group: GroupItem) => {
      const newGroup: GroupItem = {
        ...group,
        members: group.members.filter(m => m !== itemId),
      };
      vault?.store(newGroup);
    },
    [itemId, vault],
  );
  const handleClickGroup = useCallback(
    (group: GroupItem) => {
      dispatch(pushActive({ item: group.id }));
    },
    [dispatch],
  );

  return (
    <>
      {editable && (
        <Search<GroupItem>
          dataCy="groups"
          label="Add to group"
          noItemsText="No groups found"
          onSelect={handleSelectGroup}
          selectedItems={currentGroups}
          types={{ group: true }}
          searchDescription
        />
      )}

      <ItemList
        compact
        dividers
        getActionIcon={editable ? () => <DeleteIcon /> : undefined}
        items={currentGroups}
        noItemsHint="Not in any groups"
        onClick={handleClickGroup}
        onClickAction={editable ? handleRemoveGroup : undefined}
        paddingBottom={0}
        showIcons
      />
    </>
  );
}

export default GroupDisplay;

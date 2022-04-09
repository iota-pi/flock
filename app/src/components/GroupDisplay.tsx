import {
  useCallback,
  useMemo,
} from 'react';
import makeStyles from '@mui/styles/makeStyles';
import DeleteIcon from '@mui/icons-material/Close';
import { GroupItem, ItemId } from '../state/items';
import { useItems, useVault } from '../state/selectors';
import ItemList from './ItemList';
import { useAppDispatch } from '../store';
import { pushActive } from '../state/ui';
import Search from './Search';


const useStyles = makeStyles(() => ({
  list: {
    paddingBottom: 0,
  },
}));

export interface Props {
  editable?: boolean,
  itemId: ItemId,
}


function GroupDisplay({
  editable = true,
  itemId,
}: Props) {
  const allGroups = useItems<GroupItem>('group');
  const classes = useStyles();
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
          data-cy="groups"
          label="Add to group"
          noItemsText="No groups found"
          onSelect={handleSelectGroup}
          selectedItems={currentGroups}
          showSelected={false}
          types={{ group: true }}
          searchDescription
        />
      )}

      <ItemList
        className={classes.list}
        compact
        dividers
        getActionIcon={editable ? () => <DeleteIcon /> : undefined}
        items={currentGroups}
        noItemsHint="Not in any groups"
        onClick={handleClickGroup}
        onClickAction={editable ? handleRemoveGroup : undefined}
        showIcons
      />
    </>
  );
}

export default GroupDisplay;

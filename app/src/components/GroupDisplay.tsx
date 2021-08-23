import {
  useCallback,
  useMemo,
} from 'react';
import { makeStyles } from '@material-ui/core';
import DeleteIcon from '@material-ui/icons/Close';
import { compareNames, GroupItem, ItemId } from '../state/items';
import { useItems, useVault } from '../state/selectors';
import ItemList from './ItemList';
import ItemSearch from './ItemSearch';
import { useAppDispatch } from '../store';
import { pushActive } from '../state/ui';


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
  const allGroups = useItems<GroupItem>('group').sort(compareNames);
  const classes = useStyles();
  const dispatch = useAppDispatch();
  const vault = useVault();

  const groups = useMemo(
    () => allGroups.filter(g => g.members.includes(itemId)),
    [allGroups, itemId],
  );
  const groupIds = useMemo(() => groups.map(g => g.id), [groups]);

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
    (group: GroupItem) => () => {
      dispatch(pushActive({ item: group.id }));
    },
    [dispatch],
  );

  return (
    <>
      {editable && (
        <>
          <ItemSearch
            dataCy="groups"
            noItemsText="No groups found"
            onSelect={handleSelectGroup}
            items={allGroups}
            label="Add to group"
            selectedIds={groupIds}
            showSelected={false}
          />
        </>
      )}

      <ItemList
        actionIcon={editable ? <DeleteIcon /> : undefined}
        className={classes.list}
        dividers
        items={groups}
        noItemsHint="Not in any groups"
        onClick={handleClickGroup}
        onClickAction={editable ? handleRemoveGroup : undefined}
      />
    </>
  );
}

export default GroupDisplay;

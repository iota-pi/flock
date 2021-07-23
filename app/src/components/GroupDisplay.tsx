import React, {
  useCallback,
  useMemo,
} from 'react';
import { makeStyles } from '@material-ui/core';
import DeleteIcon from '@material-ui/icons/Close';
import { compareNames, GroupItem, PersonItem, updateItems } from '../state/items';
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
  item: PersonItem,
}


function GroupDisplay({
  editable = true,
  item,
}: Props) {
  const allGroups = useItems<GroupItem>('group').sort(compareNames);
  const classes = useStyles();
  const dispatch = useAppDispatch();
  const vault = useVault();

  const groups = useMemo(
    () => allGroups.filter(g => g.members.includes(item.id)).sort(compareNames),
    [allGroups, item.id],
  );
  const groupIds = useMemo(() => groups.map(g => g.id), [groups]);
  const options = useMemo(
    () => allGroups.filter(group => !groupIds.includes(group.id)),
    [groupIds, allGroups],
  );

  const handleSelectGroup = useCallback(
    (group?: GroupItem) => {
      if (group) {
        const newGroup: GroupItem = {
          ...group,
          members: [...group.members, item.id],
        };
        vault?.store(newGroup);
        dispatch(updateItems([newGroup]));
      }
    },
    [dispatch, item.id, vault],
  );
  const handleRemoveGroup = useCallback(
    (group: GroupItem) => {
      const newGroup: GroupItem = {
        ...group,
        members: group.members.filter(m => m !== item.id),
      };
      vault?.store(newGroup);
      dispatch(updateItems([newGroup]));
    },
    [dispatch, item.id, vault],
  );
  const handleClickGroup = useCallback(
    (group: GroupItem) => () => {
      dispatch(pushActive({ item: group }));
    },
    [dispatch],
  );

  return (
    <>
      {editable && (
        <>
          <ItemSearch
            noItemsText="No groups found"
            onSelect={handleSelectGroup}
            items={options}
            label="Add to group"
            selectedIds={groupIds}
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

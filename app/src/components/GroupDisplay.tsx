import React, {
  useCallback,
  useMemo,
} from 'react';
import { makeStyles } from '@material-ui/core';
import DeleteIcon from '@material-ui/icons/Close';
import { compareNames, lookupItemsById, GroupItem } from '../state/items';
import { useItems } from '../state/selectors';
import ItemList from './ItemList';
import ItemSearch from './ItemSearch';


const useStyles = makeStyles(() => ({
  list: {
    paddingBottom: 0,
  },
}));

export interface Props {
  editable?: boolean,
  groups: string[],
  onAdd: (group: GroupItem) => void,
  onClickGroup?: (group: GroupItem) => void,
  onRemove: (group: GroupItem) => void,
}


function GroupDisplay({
  editable = true,
  groups: groupIds,
  onAdd,
  onClickGroup,
  onRemove,
}: Props) {
  const classes = useStyles();
  const allGroups = useItems<GroupItem>('group').sort(compareNames);

  const groups = useMemo(
    () => lookupItemsById(allGroups, groupIds).sort(compareNames),
    [allGroups, groupIds],
  );

  const options = useMemo(
    () => allGroups.filter(group => !groupIds.includes(group.id)),
    [groupIds, allGroups],
  );

  const handleRemoveGroup = useCallback(
    (group: GroupItem) => () => onRemove(group),
    [onRemove],
  );
  const handleSelect = useCallback(
    (item?: GroupItem) => {
      if (item) {
        onAdd(item);
      }
    },
    [onAdd],
  );

  return (
    <>
      {editable && (
        <>
          <ItemSearch
            noItemsText="No groups found"
            onSelect={handleSelect}
            items={options}
            label="Add to group"
            selectedIds={groupIds}
          />
        </>
      )}

      <ItemList
        actionIcon={editable ? <DeleteIcon /> : <></>}
        className={classes.list}
        dividers
        items={groups}
        noItemsHint="Not in any groups"
        onClick={onClickGroup ? (item => () => onClickGroup(item)) : undefined}
        onClickAction={editable ? handleRemoveGroup : undefined}
      />
    </>
  );
}

export default GroupDisplay;

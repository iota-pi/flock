import React, {
  useCallback,
  useMemo,
} from 'react';
import { makeStyles } from '@material-ui/core';
import DeleteIcon from '@material-ui/icons/Close';
import { compareItems, GroupItem, Item, lookupItemsById, PersonItem } from '../state/items';
import { useItems } from '../state/selectors';
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
  item: GroupItem,
  onChange: (item: Partial<Pick<GroupItem, 'members'>>) => void,
}

function MemberDisplay({
  editable = true,
  item: group,
  onChange,
}: Props) {
  const classes = useStyles();
  const dispatch = useAppDispatch();
  const people = useItems<PersonItem>('person').sort(compareItems);

  const members = useMemo(
    () => lookupItemsById(people, group.members).sort(compareItems),
    [group.members, people],
  );

  const handleClickItem = useCallback(
    (item: PersonItem) => () => {
      dispatch(pushActive({ item }));
    },
    [dispatch],
  );
  const handleRemoveMember = useCallback(
    (member: PersonItem) => {
      onChange({ members: group.members.filter(m => m !== member.id) });
    },
    [group.members, onChange],
  );
  const handleChangeMembers = useCallback(
    (item?: Item) => {
      if (item) {
        onChange({ members: [...group.members, item.id] });
      }
    },
    [group.members, onChange],
  );

  return (
    <>
      {editable && (
        <ItemSearch
          selectedIds={group.members}
          items={people}
          label="Add group members"
          noItemsText="No people found"
          onSelect={handleChangeMembers}
          showSelected={false}
        />
      )}

      <ItemList
        actionIcon={editable ? <DeleteIcon /> : undefined}
        className={classes.list}
        dividers
        items={members}
        noItemsHint="No group members"
        onClick={handleClickItem}
        onClickAction={editable ? handleRemoveMember : undefined}
      />
    </>
  );
}

export default MemberDisplay;

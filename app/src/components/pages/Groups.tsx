import React, { useCallback, useMemo } from 'react';
import { compareItems, getBlankGroup, GroupItem } from '../../state/items';
import ItemList from '../ItemList';
import { useItems } from '../../state/selectors';
import BasePage from './BasePage';
import { updateActive } from '../../state/ui';
import { useAppDispatch } from '../../store';


function GroupsPage() {
  const dispatch = useAppDispatch();
  const rawGroups = useItems<GroupItem>('group');

  const groups = useMemo(() => rawGroups.sort(compareItems), [rawGroups]);

  const handleClickItem = useCallback(
    (item: GroupItem) => () => {
      dispatch(updateActive({ item }));
    },
    [dispatch],
  );
  const handleClickAdd = useCallback(
    () => {
      dispatch(updateActive({ item: getBlankGroup() }));
    },
    [dispatch],
  );
  const getDescription = useCallback(
    (item: GroupItem) => {
      const n = item.members.length;
      const s = n !== 1 ? 's' : '';
      const description = item.description ? ` — ${item.description}` : '';
      return `${n} member${s}${description}`;
    },
    [],
  );

  return (
    <BasePage
      fab
      fabLabel="Add Group"
      onClickFab={handleClickAdd}
    >
      <ItemList
        items={groups}
        noItemsHint="Click the plus button to add one!"
        noItemsText="No groups found"
        onClick={handleClickItem}
        getDescription={getDescription}
      />
    </BasePage>
  );
}

export default GroupsPage;

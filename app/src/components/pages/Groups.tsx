import React, { useCallback, useMemo, useState } from 'react';
import { compareItems, GroupItem } from '../../state/items';
import ItemList from '../ItemList';
import GroupDrawer from '../drawers/Group';
import { useItems } from '../../state/selectors';
import BasePage from './BasePage';


function GroupsPage() {
  const rawGroups = useItems<GroupItem>('group');
  const groups = useMemo(() => rawGroups.sort(compareItems), [rawGroups]);

  const [showDetails, setShowDetails] = useState(false);
  const [currentGroup, setCurrentGroup] = useState<GroupItem>();

  const handleClickGroup = useCallback(
    (group: GroupItem) => () => {
      setShowDetails(true);
      setCurrentGroup(group);
    },
    [],
  );
  const handleClickAdd = useCallback(
    () => {
      setShowDetails(true);
      setCurrentGroup(undefined);
    },
    [],
  );
  const handleCloseDetails = useCallback(() => setShowDetails(false), []);
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
        onClick={handleClickGroup}
        getDescription={getDescription}
      />

      <GroupDrawer
        open={showDetails}
        onClose={handleCloseDetails}
        item={currentGroup}
      />
    </BasePage>
  );
}

export default GroupsPage;

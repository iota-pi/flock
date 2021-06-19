import React, { useCallback, useMemo, useState } from 'react';
import makeStyles from '@material-ui/core/styles/makeStyles';
import { Fab } from '@material-ui/core';
import AddIcon from '@material-ui/icons/Add';
import { compareNames, GroupItem } from '../../state/items';
import ItemList from '../ItemList';
import GroupDrawer from '../drawers/Group';
import { useItems } from '../../state/selectors';

const useStyles = makeStyles(theme => ({
  root: {
    position: 'relative',
    flexGrow: 1,
  },
  fab: {
    position: 'absolute',
    bottom: theme.spacing(3),
    right: theme.spacing(3),
  },
}));


function GroupsPage() {
  const classes = useStyles();
  const rawGroups = useItems<GroupItem>('group');
  const groups = useMemo(() => rawGroups.sort(compareNames), [rawGroups]);

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

  return (
    <div className={classes.root}>
      <ItemList
        items={groups}
        noItemsHint="Click the plus button to add one!"
        noItemsText="No groups found"
        onClick={handleClickGroup}
      />

      <Fab
        onClick={handleClickAdd}
        color="secondary"
        aria-label="Add Group"
        className={classes.fab}
      >
        <AddIcon />
      </Fab>

      <GroupDrawer
        open={showDetails}
        onClose={handleCloseDetails}
        item={currentGroup}
      />
    </div>
  );
}

export default GroupsPage;

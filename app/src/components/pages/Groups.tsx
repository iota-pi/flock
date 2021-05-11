import React, { useCallback, useMemo, useState } from 'react';
import makeStyles from '@material-ui/core/styles/makeStyles';
import { Fab } from '@material-ui/core';
import AddIcon from '@material-ui/icons/Add';
import { useAppSelector } from '../../store';
import { GroupItem } from '../../state/items';
import ItemList from '../ItemList';
import GroupDrawer from '../drawers/Group';

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
  chevronButton: {
    '&:hover': {
      backgroundColor: 'transparent',
    },
  },
}));


function GroupsPage() {
  const classes = useStyles();
  const items = useAppSelector(state => state.items);
  const groups = useMemo(
    () => {
      const onlyGroups = items.filter(item => item.type === 'group') as GroupItem[];
      return onlyGroups.sort((a, b) => +(a.name > b.name) - +(a.name < b.name));
    },
    [items],
  );

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
        group={currentGroup}
      />
    </div>
  );
}

export default GroupsPage;

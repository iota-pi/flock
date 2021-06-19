import React, { useCallback, useMemo, useState } from 'react';
import makeStyles from '@material-ui/core/styles/makeStyles';
import { Fab } from '@material-ui/core';
import AddIcon from '@material-ui/icons/Add';
import { compareNames, GeneralItem } from '../../state/items';
import ItemList from '../ItemList';
import GeneralDrawer from '../drawers/General';
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


function GeneralPage() {
  const classes = useStyles();
  const rawItems = useItems<GeneralItem>('general');
  const items = useMemo(() => rawItems.sort(compareNames), [rawItems]);

  const [showDetails, setShowDetails] = useState(false);
  const [currentItem, setCurrentItem] = useState<GeneralItem>();

  const handleClickItem = useCallback(
    (item: GeneralItem) => () => {
      setShowDetails(true);
      setCurrentItem(item);
    },
    [],
  );
  const handleClickAdd = useCallback(
    () => {
      setShowDetails(true);
      setCurrentItem(undefined);
    },
    [],
  );
  const handleCloseDetails = useCallback(() => setShowDetails(false), []);

  return (
    <div className={classes.root}>
      <ItemList
        items={items}
        noItemsHint="Click the plus button to add one!"
        noItemsText="No items found"
        onClick={handleClickItem}
      />

      <Fab
        onClick={handleClickAdd}
        color="secondary"
        aria-label="Add Prayer Item"
        className={classes.fab}
      >
        <AddIcon />
      </Fab>

      <GeneralDrawer
        open={showDetails}
        onClose={handleCloseDetails}
        item={currentItem}
      />
    </div>
  );
}

export default GeneralPage;

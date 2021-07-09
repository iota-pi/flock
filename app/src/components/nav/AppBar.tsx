import React, { useCallback, useState } from 'react';
import makeStyles from '@material-ui/core/styles/makeStyles';
import { AppBar as MuiAppBar, Button, IconButton, Toolbar, Typography } from '@material-ui/core';
import ExpandMenuIcon from '@material-ui/icons/ChevronRight';
import ContractMenuIcon from '@material-ui/icons/ChevronLeft';
import { APP_NAME } from '../../utils';
import { clearVault } from '../../state/vault';
import { useAppDispatch } from '../../store';
import EverythingSearch from './EverythingSearch';
import AnyItemDrawer from '../drawers/AnyItemDrawer';
import { Item } from '../../state/items';

const useStyles = makeStyles(theme => ({
  root: {
    zIndex: theme.zIndex.drawer + 1,
  },
  searchField: {
    flexGrow: 1,
    marginLeft: theme.spacing(2),
    marginRight: theme.spacing(2),
  },
  menuButton: {
    marginRight: theme.spacing(2),
  },
}));

export interface Props {
  showMenu: boolean,
  onShowMenu: () => void,
}


function AppBar({
  showMenu,
  onShowMenu,
}: Props) {
  const classes = useStyles();
  const dispatch = useAppDispatch();

  const [showDrawer, setShowDrawer] = useState(false);
  const [currentItem, setCurrentItem] = useState<Item>();

  const handleClickSignOut = useCallback(
    () => {
      dispatch(clearVault());
    },
    [dispatch],
  );
  const handleSelect = useCallback(
    (item: Item | string | undefined) => {
      if (item !== undefined) {
        if (typeof item === 'string') {
          console.warn(item);
          setCurrentItem(undefined);
          setShowDrawer(false);
        } else {
          setCurrentItem(item);
          setShowDrawer(true);
        }
      }
    },
    [],
  );
  const handleCloseDrawer = useCallback(() => setShowDrawer(false), []);

  return (
    <MuiAppBar
      position="fixed"
      className={classes.root}
    >
      <Toolbar>
        <IconButton
          edge="start"
          color="inherit"
          aria-label="menu"
          onClick={onShowMenu}
          className={classes.menuButton}
        >
          {showMenu ? <ContractMenuIcon /> : <ExpandMenuIcon /> }
        </IconButton>

        <Typography variant="h6" color="inherit">
          {APP_NAME}
        </Typography>

        <div className={classes.searchField}>
          <EverythingSearch
            label="Search"
            onSelect={handleSelect}
          />
        </div>

        <Button onClick={handleClickSignOut}>
          Sign Out
        </Button>
      </Toolbar>

      <AnyItemDrawer
        item={currentItem}
        open={showDrawer}
        onClose={handleCloseDrawer}
      />
    </MuiAppBar>
  );
}

export default AppBar;

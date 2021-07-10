import React, { useCallback, useState } from 'react';
import { useHistory, useRouteMatch } from 'react-router-dom';
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
import { getPage, getTagPage } from '../pages';

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
  minimisedMenu: boolean,
  onMinimiseMenu: () => void,
}

function useTagParam() {
  const params = useRouteMatch(getPage('tag').path)?.params as { tag: string } | undefined;
  return params?.tag;
}


function AppBar({
  minimisedMenu,
  onMinimiseMenu,
}: Props) {
  const classes = useStyles();
  const dispatch = useAppDispatch();
  const history = useHistory();
  const tag = useTagParam();

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
          history.push(getTagPage(item));
          setCurrentItem(undefined);
          setShowDrawer(false);
        } else {
          setCurrentItem(item);
          setShowDrawer(true);
        }
      }
    },
    [history],
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
          onClick={onMinimiseMenu}
          className={classes.menuButton}
        >
          {minimisedMenu ? <ExpandMenuIcon /> : <ContractMenuIcon />}
        </IconButton>

        <Typography variant="h6" color="inherit">
          {APP_NAME}
        </Typography>

        <div className={classes.searchField}>
          <EverythingSearch
            label={tag || 'Search'}
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

import React, { useCallback, useState } from 'react';
import { useHistory, useRouteMatch } from 'react-router-dom';
import makeStyles from '@material-ui/core/styles/makeStyles';
import {
  AppBar as MuiAppBar,
  IconButton,
  Toolbar,
  Tooltip,
  Typography,
} from '@material-ui/core';
import ExpandMenuIcon from '@material-ui/icons/ChevronRight';
import ContractMenuIcon from '@material-ui/icons/ChevronLeft';
import { APP_NAME } from '../../utils';
import { clearVault } from '../../state/vault';
import { useAppDispatch } from '../../store';
import EverythingSearch from './EverythingSearch';
import { Item } from '../../state/items';
import { getPage, getTagPage } from '../pages';
import { DRAWER_SPACING_FULL, DRAWER_SPACING_NARROW } from './MainMenu';
import { SignOutIcon } from '../Icons';
import { updateActive } from '../../state/ui';

const useStyles = makeStyles(theme => ({
  root: {
    zIndex: theme.zIndex.drawer + 1,
  },
  toolbar: {
    paddingRight: theme.spacing(2),
  },
  searchField: {
    flexGrow: 1,
    marginLeft: theme.spacing(1),
    marginRight: theme.spacing(1),
  },
  menuButton: {
    marginRight: theme.spacing(2),
  },
  preSearch: {
    display: 'flex',
    alignItems: 'center',
    minWidth: theme.spacing(DRAWER_SPACING_FULL - 3),
    paddingRight: theme.spacing(4),

    '$minimised &': {
      minWidth: theme.spacing(DRAWER_SPACING_NARROW - 3),
    },
  },
  minimised: {},
  signoutButton: {
    marginLeft: theme.spacing(1),
  },
}));

export interface Props {
  minimisedMenu: boolean,
  onMinimiseMenu: () => void,
}

function useTagParam() {
  const params = useRouteMatch(getPage('tag').path)?.params as { tag: string } | undefined;
  return params?.tag ? decodeURIComponent(params?.tag) : undefined;
}


function AppBar({
  minimisedMenu,
  onMinimiseMenu,
}: Props) {
  const classes = useStyles();
  const dispatch = useAppDispatch();
  const history = useHistory();
  const tag = useTagParam();

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
        } else {
          dispatch(updateActive({ item }));
        }
      }
    },
    [dispatch, history],
  );

  return (
    <MuiAppBar
      position="fixed"
      className={`${classes.root} ${minimisedMenu ? classes.minimised : ''}`}
    >
      <Toolbar className={classes.toolbar}>
        <div className={classes.preSearch}>
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
        </div>

        <div className={classes.searchField}>
          <EverythingSearch
            label={tag || 'Search'}
            onSelect={handleSelect}
          />
        </div>

        <div className={classes.signoutButton}>
          <Tooltip title="Sign out">
            <IconButton onClick={handleClickSignOut}>
              <SignOutIcon />
            </IconButton>
          </Tooltip>
        </div>
      </Toolbar>
    </MuiAppBar>
  );
}

export default AppBar;

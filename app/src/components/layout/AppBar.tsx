import { useCallback } from 'react';
import { useRouteMatch } from 'react-router-dom';
import makeStyles from '@material-ui/styles/makeStyles';
import {
  AppBar as MuiAppBar,
  IconButton,
  Theme,
  Toolbar,
  Tooltip,
  Typography,
  useMediaQuery,
} from '@material-ui/core';
import ExpandMenuIcon from '@material-ui/icons/ChevronRight';
import ContractMenuIcon from '@material-ui/icons/ChevronLeft';
import { APP_NAME } from '../../utils';
import { clearVault } from '../../state/vault';
import { useAppDispatch } from '../../store';
import EverythingSearch from './EverythingSearch';
import { getPage } from '../pages';
import { DRAWER_SPACING_FULL, DRAWER_SPACING_NARROW } from './MainMenu';
import { SignOutIcon } from '../Icons';

const useStyles = makeStyles(theme => ({
  toolbar: {
    paddingLeft: theme.spacing(3),
    paddingRight: theme.spacing(2),

    [theme.breakpoints.down('sm')]: {
      paddingRight: theme.spacing(1),
    },
  },
  searchField: {
    flexGrow: 1,
    marginLeft: theme.spacing(1),
    marginRight: theme.spacing(1),

    [theme.breakpoints.down('sm')]: {
      marginLeft: 0,
      marginRight: 0,
    },
  },
  menuButton: {
    marginRight: theme.spacing(2),
  },
  preSearch: {
    display: 'flex',
    alignItems: 'center',
    minWidth: theme.spacing(DRAWER_SPACING_FULL - 3),
    paddingLeft: theme.spacing(0.5),
    paddingRight: theme.spacing(3.5),
    transition: theme.transitions.create(['padding', 'min-width']),

    '$minimised &': {
      minWidth: theme.spacing(DRAWER_SPACING_NARROW - 3),
    },

    [theme.breakpoints.down('sm')]: {
      minWidth: theme.spacing(DRAWER_SPACING_NARROW - 3),
      paddingRight: 0,
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
  const tag = useTagParam();
  const showAppTitle = useMediaQuery((theme: Theme) => theme.breakpoints.up('sm'));

  const handleClickSignOut = useCallback(
    () => {
      dispatch(clearVault());
    },
    [dispatch],
  );

  return (
    <MuiAppBar
      className={minimisedMenu ? classes.minimised : undefined}
      enableColorOnDark
      position="fixed"
    >
      <Toolbar className={classes.toolbar}>
        <div className={classes.preSearch}>
          <IconButton
            edge="start"
            color="inherit"
            aria-label="menu"
            onClick={onMinimiseMenu}
            className={classes.menuButton}
            size="large"
          >
            {minimisedMenu ? <ExpandMenuIcon /> : <ContractMenuIcon />}
          </IconButton>

          {showAppTitle && (
            <Typography variant="h6" color="inherit">
              {APP_NAME}
            </Typography>
          )}
        </div>

        <div className={classes.searchField}>
          <EverythingSearch label={tag || 'Search'} />
        </div>

        <div className={classes.signoutButton}>
          <Tooltip title="Sign out">
            <IconButton onClick={handleClickSignOut} size="large">
              <SignOutIcon />
            </IconButton>
          </Tooltip>
        </div>
      </Toolbar>
    </MuiAppBar>
  );
}

export default AppBar;

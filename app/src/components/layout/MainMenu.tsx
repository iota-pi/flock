import { Fragment, memo, ReactNode, useCallback } from 'react';
import { useHistory } from 'react-router-dom';
import makeStyles from '@material-ui/styles/makeStyles';
import {
  alpha,
  Divider,
  Drawer,
  List,
  ListItem,
  ListItemIcon,
  ListItemText,
  Toolbar,
} from '@material-ui/core';
import { Page, pages, withPage } from '../pages';
import { useAppDispatch } from '../../store';
import { setUiState } from '../../state/ui';

export const DRAWER_SPACING_FULL = 30;
export const DRAWER_SPACING_NARROW = 10;

const useStyles = makeStyles(theme => ({
  drawer: {
    width: theme.spacing(DRAWER_SPACING_FULL),
    flexShrink: 0,
    transition: theme.transitions.create('width'),
    zIndex: theme.zIndex.appBar - 1,

    '&$minimised': {
      width: theme.spacing(DRAWER_SPACING_NARROW),
    },
  },
  drawerPaper: {
    width: theme.spacing(DRAWER_SPACING_FULL),
    transition: theme.transitions.create('width'),

    '$minimised &': {
      width: theme.spacing(DRAWER_SPACING_NARROW),
    },
  },
  drawerContainer: {
    overflowX: 'hidden',
    overflowY: 'auto',
  },
  menuItem: {
    transition: theme.transitions.create(['color', 'height']),
    justifyContent: 'center',
    height: theme.spacing(6),
  },
  primary: {
    color: (
      theme.palette.mode === 'dark'
        ? theme.palette.primary.light
        : theme.palette.primary.main
    ),
    backgroundColor: (
      theme.palette.mode === 'dark'
        ? `${alpha('#fff', 0.08)} !important`
        : `${alpha(theme.palette.primary.main, 0.08)} !important`
    ),
  },
  menuItemIcon: {
    color: 'inherit',
    minWidth: 0,
    paddingLeft: theme.spacing(0.5),
    paddingRight: theme.spacing(3),
    transition: theme.transitions.create('padding'),
  },
  minimised: {
    '& $menuItemIcon': {
      paddingLeft: theme.spacing(1.5),
      paddingRight: theme.spacing(0),
    },

    '& $menuItem': {
      height: theme.spacing(8),
    },
  },
  menuItemText: {
    whiteSpace: 'nowrap',
    overflowX: 'hidden',
    textOverflow: 'ellipsis',
    transition: theme.transitions.create('opacity'),

    '$minimised &': {
      opacity: 0,
    },
  },
  menuItemTextTypography: {
    display: 'inline',
  },
}));

export interface Props {
  minimised?: boolean,
  open: boolean,
  page: Page,
}

export interface UserInterface {
  id: string,
  name: string,
  icon: ReactNode,
}


function MainMenu({
  minimised,
  open,
  page,
}: Props) {
  const classes = useStyles();
  const dispatch = useAppDispatch();
  const history = useHistory();

  const handleClick = useCallback(
    (pageId: string) => () => {
      if (page.id !== pageId) {
        const newPage = pages.find(p => p.id === pageId)! || '';
        history.push(newPage.path);
        dispatch(setUiState({ selected: [] }));
      }
    },
    [page.id, dispatch, history],
  );

  return (
    <Drawer
      className={`${classes.drawer} ${minimised ? classes.minimised : ''}`}
      variant="persistent"
      open={open}
      classes={{
        paper: classes.drawerPaper,
      }}
    >
      <Toolbar />

      <div className={classes.drawerContainer}>
        <List>
          {pages.map(({ id, name, icon: Icon, dividerBefore }) => (
            <Fragment key={id}>
              {dividerBefore && (
                <Divider />
              )}

              <ListItem
                button
                className={`${classes.menuItem} ${id === page.id ? classes.primary : ''}`}
                data-cy={`page-${id}`}
                onClick={handleClick(id)}
              >
                <ListItemIcon className={classes.menuItemIcon}>
                  <Icon />
                </ListItemIcon>

                <ListItemText
                  primary={name}
                  className={classes.menuItemText}
                  classes={{
                    primary: classes.menuItemTextTypography,
                  }}
                />
              </ListItem>
            </Fragment>
          ))}
        </List>
      </div>
    </Drawer>
  );
}
const MemoMainMenu = memo(MainMenu);

export default withPage(MemoMainMenu);

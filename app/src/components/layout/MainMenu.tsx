import { memo, ReactNode, useCallback } from 'react';
import { useHistory } from 'react-router-dom';
import makeStyles from '@mui/styles/makeStyles';
import {
  alpha,
  Box,
  Divider,
  Drawer,
  List,
  ListItem,
  ListItemIcon,
  ListItemText,
  styled,
  Toolbar,
} from '@mui/material';
import { Page, PageId, pages, withPage } from '../pages';
import { useAppDispatch } from '../../store';
import { setUiState } from '../../state/ui';
import { ContractMenuIcon, ExpandMenuIcon, MuiIconType } from '../Icons';

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
    '&$closed': {
      width: 0,
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
    display: 'flex',
    flexGrow: 1,
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
  closed: {},
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

const FlexList = styled(List)({
  display: 'flex',
  flexDirection: 'column',
  flexGrow: 1,
});

export interface Props {
  minimised?: boolean,
  onMinimise: () => void,
  open: boolean,
  page: Page,
}

export interface UserInterface {
  id: string,
  name: string,
  icon: ReactNode,
}

type MenuActionId = 'minimise';

export interface MainMenuItemProps {
  dividerBefore?: boolean,
  icon: MuiIconType,
  id: PageId | MenuActionId,
  name: string,
  onClick: (pageId?: PageId) => void,
  selected: boolean,
}


function MainMenuItem({
  dividerBefore,
  icon: Icon,
  id,
  name,
  onClick,
  selected,
}: MainMenuItemProps) {
  const classes = useStyles();

  const handleClick = useCallback(
    () => (id !== 'minimise' ? onClick(id) : onClick()),
    [id, onClick],
  );

  return (
    <>
      {dividerBefore && (
        <Divider />
      )}

      <ListItem
        button
        className={`${classes.menuItem} ${selected ? classes.primary : ''}`}
        data-cy={`page-${id}`}
        onClick={handleClick}
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
    </>
  );
}


function MainMenu({
  minimised,
  onMinimise,
  open,
  page,
}: Props) {
  const classes = useStyles();
  const dispatch = useAppDispatch();
  const history = useHistory();

  const handleClick = useCallback(
    (pageId?: PageId) => {
      if (pageId && page.id !== pageId) {
        const newPage = pages.find(p => p.id === pageId)!;
        history.push(newPage.path);
        dispatch(setUiState({ selected: [] }));
      }
    },
    [page.id, dispatch, history],
  );

  return (
    <Drawer
      className={
        `${classes.drawer} ${minimised ? classes.minimised : ''} ${open ? '' : classes.closed}`
      }
      variant="persistent"
      open={open}
      classes={{
        paper: classes.drawerPaper,
      }}
    >
      <Toolbar />

      <div className={classes.drawerContainer}>
        <FlexList>
          {pages.map(({ id, name, icon: Icon, dividerBefore }) => (
            <MainMenuItem
              key={id}
              dividerBefore={dividerBefore}
              icon={Icon}
              id={id}
              name={name}
              onClick={handleClick}
              selected={id === page.id}
            />
          ))}

          <Box flexGrow={1} />

          <MainMenuItem
            // dividerBefore
            icon={minimised ? ExpandMenuIcon : ContractMenuIcon}
            id="minimise"
            name="Collapse Menu"
            onClick={onMinimise}
            selected={false}
          />
        </FlexList>
      </div>
    </Drawer>
  );
}
const MemoMainMenu = memo(MainMenu);

export default withPage(MemoMainMenu);

import React, { ReactNode, useCallback } from 'react';
import { useHistory, useLocation } from 'react-router-dom';
import makeStyles from '@material-ui/core/styles/makeStyles';
import {
  Divider,
  Drawer,
  List,
  ListItem,
  ListItemIcon,
  ListItemText,
  Toolbar,
} from '@material-ui/core';
import { pages } from '../pages';

const drawerWidth = 240;

const useStyles = makeStyles(theme => ({
  drawer: {
    width: drawerWidth,
    flexShrink: 0,
  },
  drawerPaper: {
    width: drawerWidth,
  },
  drawerContainer: {
    overflowX: 'hidden',
    overflowY: 'auto',
  },
  menuButton: {
    marginRight: theme.spacing(2),
  },
  primaryMenuItem: {
    color: theme.palette.primary.light,
    transition: theme.transitions.create('color'),
  },
  regularMenuItem: {
    transition: theme.transitions.create('color'),
  },
  inheritColour: {
    color: 'inherit',
  },
}));

export interface Props {
  open: boolean,
}

export interface UserInterface {
  id: string,
  name: string,
  icon: ReactNode,
}


function MainMenu({
  open,
}: Props) {
  const classes = useStyles();
  const history = useHistory();
  const location = useLocation();

  const handleClick = useCallback(
    (pageId: string) => () => {
      const page = pages.find(p => p.id === pageId)! || '';
      history.push(page.path);
    },
    [history],
  );
  const currentPageId = pages.find(p => p.path === location.pathname)?.id;

  return (
    <Drawer
      className={classes.drawer}
      variant="persistent"
      open={open}
      classes={{
        paper: classes.drawerPaper,
      }}
    >
      <Toolbar />

      <div className={classes.drawerContainer}>
        <List>
          {pages.map(({ id, name, icon, dividerBefore }) => (
            <React.Fragment key={id}>
              {dividerBefore && (
                <Divider />
              )}

              <ListItem
                button
                onClick={handleClick(id)}
                className={id === currentPageId ? classes.primaryMenuItem : classes.regularMenuItem}
              >
                <ListItemIcon className={classes.inheritColour}>
                  {icon}
                </ListItemIcon>
                <ListItemText primary={name} />
              </ListItem>
            </React.Fragment>
          ))}
        </List>
      </div>
    </Drawer>
  );
}

export default MainMenu;

import React, { ReactNode, useCallback } from 'react';
import { useHistory } from 'react-router-dom';
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

  const handleClick = useCallback(
    (pageId: string) => () => {
      const page = pages.find(p => p.id === pageId)! || '';
      history.push(page.path);
    },
    [history],
  );

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
          {pages.map(({ id, name, icon }) => (
            <ListItem
              key={id}
              button
              onClick={handleClick(id)}
            >
              <ListItemIcon>{icon}</ListItemIcon>
              <ListItemText primary={name} />
            </ListItem>
          ))}
        </List>
        <Divider />
      </div>
    </Drawer>
  );
}

export default MainMenu;

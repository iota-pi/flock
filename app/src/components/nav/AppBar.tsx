import React from 'react';
import makeStyles from '@material-ui/core/styles/makeStyles';
import { AppBar as MuiAppBar, IconButton, Toolbar, Typography } from '@material-ui/core';
import ExpandMenuIcon from '@material-ui/icons/ChevronRight';
import ContractMenuIcon from '@material-ui/icons/ChevronLeft';

const useStyles = makeStyles(theme => ({
  root: {
    zIndex: theme.zIndex.drawer + 1,
  },
  grow: {
    flexGrow: 1,
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

        <Typography variant="h6" color="inherit" className={classes.grow}>
          PRM
        </Typography>
      </Toolbar>
    </MuiAppBar>
  );
}

export default AppBar;

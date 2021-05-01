import React, { useCallback, useState } from 'react';
import { BrowserRouter as Router } from 'react-router-dom';
import { Toolbar } from '@material-ui/core';
import { makeStyles } from '@material-ui/core/styles';
import AppBar from './components/nav/AppBar';
import MainMenu from './components/nav/MainMenu';
import PageView from './components/pages';


const useStyles = makeStyles(theme => ({
  root: {
    display: 'flex',
    height: '100vh',
  },
  section: {
    paddingTop: theme.spacing(4),
    paddingBottom: theme.spacing(4),
  },
  paddingTop: {
    paddingTop: theme.spacing(2),
  },
  content: {
    flexGrow: 1,
    display: 'flex',
    flexDirection: 'column',
  },
}));

export default function App() {
  const classes = useStyles();
  const [open, setOpen] = useState(true);

  const handleShowMenu = useCallback(
    () => {
      setOpen(!open);
    },
    [open],
  );

  return (
    <>
      <Router>
        <div className={classes.root}>
          <AppBar
            showMenu={open}
            onShowMenu={handleShowMenu}
          />

          <MainMenu open={open} />

          <div className={classes.content}>
            <Toolbar />
            <PageView />
          </div>
        </div>
      </Router>
    </>
  );
}

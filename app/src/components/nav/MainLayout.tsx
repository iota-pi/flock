import React, { PropsWithChildren } from 'react';
import makeStyles from '@material-ui/core/styles/makeStyles';
import DrawerDisplay from '../DrawerDisplay';

const useStyles = makeStyles(() => ({
  root: {
    display: 'flex',
    flexGrow: 1,
  },
}));


function MainLayout({ children }: PropsWithChildren<{}>) {
  const classes = useStyles();

  return (
    <div className={classes.root}>
      {children}

      <DrawerDisplay />
    </div>
  );
}

export default MainLayout;

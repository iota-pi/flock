import React from 'react';
import makeStyles from '@material-ui/core/styles/makeStyles';
import { Container } from '@material-ui/core';

const useStyles = makeStyles(theme => ({
  root: {
    padding: theme.spacing(2),
    flexGrow: 1,
  },
}));


function LoginPage() {
  const classes = useStyles();

  return (
    <Container
      className={classes.root}
    >
      Login
    </Container>
  );
}

export default LoginPage;

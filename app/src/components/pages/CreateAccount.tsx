import React, { useCallback } from 'react';
import { useHistory } from 'react-router-dom';
import makeStyles from '@material-ui/core/styles/makeStyles';
import { Button, Container, TextField, Typography } from '@material-ui/core';
import { getPage } from '.';

const useStyles = makeStyles(theme => ({
  root: {
    padding: theme.spacing(4),
    flexGrow: 1,
  },
  section: {
    paddingBottom: theme.spacing(8),
  },
  textFieldHolder: {
    display: 'flex',
  },
  textField: {
    marginBottom: theme.spacing(2),
    flexGrow: 1,
    maxWidth: 400,
  },
}));


function CreateAccountPage() {
  const classes = useStyles();
  const history = useHistory();

  const handleClickLogin = useCallback(
    () => {
      history.push(getPage('login').path);
    },
    [history],
  );

  return (
    <Container
      className={classes.root}
    >
      <div className={classes.section}>
        <Typography variant="h4" gutterBottom>
          Create a New Account
        </Typography>

        <Typography paragraph>
          When you create an account you will be given an account id.
          Please ensure that you store your account id and password in a secure location.
        </Typography>

        <Typography paragraph>
          Because your data is end-to-end encrypted, it is impossible to recover your data
          if you forget your account id or password.
        </Typography>

        <div className={classes.textFieldHolder}>
          <TextField
            id="password"
            label="Password"
            type="password"
            className={classes.textField}
          />
        </div>

        <Button color="primary" variant="contained" size="large">
          Create Account
        </Button>
      </div>

      <div className={classes.section}>
        <Typography variant="h4" gutterBottom>
          Login to Existing Account
        </Typography>

        <Button
          color="primary"
          variant="contained"
          size="large"
          onClick={handleClickLogin}
        >
          Login
        </Button>


      </div>
    </Container>
  );
}

export default CreateAccountPage;

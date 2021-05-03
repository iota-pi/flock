import React, { ChangeEvent, useCallback, useState } from 'react';
import { useHistory } from 'react-router-dom';
import makeStyles from '@material-ui/core/styles/makeStyles';
import { Button, Container, TextField, Typography } from '@material-ui/core';
import { getPage } from '.';
import VaultAPI from '../../crypto/api';
import Vault, { registerVault } from '../../crypto/Vault';
import { getAccountId } from '../../utils';

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
  errorMessage: {
    marginTop: theme.spacing(2),
  },
}));

const api = new VaultAPI();


function CreateAccountPage() {
  const classes = useStyles();
  const history = useHistory();
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  const handleClickLogin = useCallback(
    () => {
      history.push(getPage('login').path);
    },
    [history],
  );
  const handleClickCreate = useCallback(
    async () => {
      const account = getAccountId();
      const vault = await Vault.create(account, password);
      const success = await api.createAccount({ account, authToken: vault.authToken });
      if (success) {
        registerVault(vault);
        setError('');
        history.push(getPage('people').path);
      } else {
        setError('An error occured while creating your account.');
      }
    },
    [history, password],
  );
  const handleChangePassword = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setPassword(event.target.value),
    [],
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
          When you create an account you will be given an account ID.
          Please ensure that you store your account ID and password in a secure location.
        </Typography>

        <Typography paragraph>
          Because your data is end-to-end encrypted, it will not be possible to recover your data
          if you forget your account ID or password.
        </Typography>

        <div className={classes.textFieldHolder}>
          <TextField
            id="password"
            label="Password"
            type="password"
            onChange={handleChangePassword}
            className={classes.textField}
          />
        </div>

        <Button
          color="primary"
          variant="contained"
          size="large"
          onClick={handleClickCreate}
        >
          Create Account
        </Button>

        {error && (
          <Typography paragraph color="error" className={classes.errorMessage}>
            {error}
          </Typography>
        )}
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

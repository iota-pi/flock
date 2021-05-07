import React, { ChangeEvent, useCallback, useEffect, useState } from 'react';
import { useHistory, useLocation } from 'react-router-dom';
import makeStyles from '@material-ui/core/styles/makeStyles';
import { Button, Container, TextField, Typography } from '@material-ui/core';
import { Alert } from '@material-ui/lab';
import { getPage } from '.';
import VaultAPI from '../../crypto/api';
import Vault from '../../crypto/Vault';
import { useAppDispatch } from '../../store';
import { setAccount } from '../../state/account';
import { setVault } from '../../state/vault';


const useStyles = makeStyles(theme => ({
  root: {
    padding: theme.spacing(4),
    flexGrow: 1,
  },
  alert: {
    marginBottom: theme.spacing(4),
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


function LoginPage() {
  const classes = useStyles();
  const dispatch = useAppDispatch();
  const history = useHistory();
  const location = useLocation();

  const [error, setError] = useState('');
  const [password, setPassword] = useState('');
  const [accountInput, setAccountInput] = useState('');

  useEffect(
    () => {
      if (location.state) {
        const { account } = location.state as { account: string | undefined };
        if (account) {
          setAccountInput(account);
        }
      }
    },
    [location],
  );

  const handleClickLogin = useCallback(
    async () => {
      const vault = await Vault.create(accountInput, password);
      const success = await api.checkPassword({
        account: accountInput,
        authToken: vault.authToken,
      });
      if (success) {
        dispatch(await setVault(vault));
        dispatch(setAccount(accountInput));
        history.push(getPage('people').path);
      } else {
        setError('Could not find matching account ID and password.');
      }
    },
    [accountInput, dispatch, history, password],
  );
  const handleClickCreate = useCallback(
    () => {
      history.push(getPage('signup').path);
    },
    [history],
  );
  const handleChangeAccount = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setAccountInput(event.target.value),
    [],
  );
  const handleChangePassword = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setPassword(event.target.value),
    [],
  );

  const justCreated = (location.state as { created: boolean } | undefined)?.created || false;

  return (
    <Container className={classes.root}>
      {justCreated && (
        <Alert severity="success" className={classes.alert}>
          Account successfully created!
          Please record your account ID and password and login again to continue.
        </Alert>
      )}

      <div className={classes.section}>
        <Typography variant="h4" gutterBottom>
          Login to Existing Account
        </Typography>

        <form>
          <div className={classes.textFieldHolder}>
            <TextField
              id="username"
              name="username"
              label="Account ID"
              autoComplete="username"
              value={accountInput}
              onChange={handleChangeAccount}
              className={classes.textField}
            />
          </div>

          <div className={classes.textFieldHolder}>
            <TextField
              id="current-password"
              autoComplete="current-password"
              name="password"
              label="Password"
              type="password"
              value={password}
              onChange={handleChangePassword}
              className={classes.textField}
            />
          </div>

          <Button
            color="primary"
            variant="contained"
            size="large"
            onClick={handleClickLogin}
          >
            Login
          </Button>

          {error && (
            <Typography paragraph color="error" className={classes.errorMessage}>
              {error}
            </Typography>
          )}
        </form>
      </div>

      <div className={classes.section}>
        <Typography variant="h5" gutterBottom>
          Create a New Account
        </Typography>

        <Button
          color="primary"
          variant="contained"
          size="large"
          onClick={handleClickCreate}
        >
          Create
        </Button>
      </div>
    </Container>
  );
}

export default LoginPage;

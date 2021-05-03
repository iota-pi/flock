import React, { ChangeEvent, useCallback } from 'react';
import { useHistory } from 'react-router-dom';
import makeStyles from '@material-ui/core/styles/makeStyles';
import { Button, Container, TextField, Typography } from '@material-ui/core';
import { useAppDispatch, useAppSelector } from '../../store';
import { setAccount } from '../../state/account';
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


function LoginPage() {
  const classes = useStyles();
  const account = useAppSelector(state => state.account);
  const dispatch = useAppDispatch();
  const history = useHistory();

  const handleClickCreate = useCallback(
    () => {
      history.push(getPage('signup').path);
    },
    [history],
  );
  const handleChangeAccount = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      dispatch(setAccount(event.target.value));
    },
    [dispatch],
  );

  return (
    <Container
      className={classes.root}
    >
      <div className={classes.section}>
        <Typography variant="h4" gutterBottom>
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

      <div className={classes.section}>
        <Typography variant="h4" gutterBottom>
          Login to Existing Account
        </Typography>

        <div className={classes.textFieldHolder}>
          <TextField
            id="account-id"
            label="Account ID"
            value={account || ''}
            onChange={handleChangeAccount}
            className={classes.textField}
          />
        </div>

        <div className={classes.textFieldHolder}>
          <TextField
            id="password"
            label="Password"
            type="password"
            className={classes.textField}
          />
        </div>

        <Button color="primary" variant="contained" size="large">
          Check
        </Button>
      </div>
    </Container>
  );
}

export default LoginPage;

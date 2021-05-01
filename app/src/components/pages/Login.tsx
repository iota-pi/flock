import React, { ChangeEvent, useCallback } from 'react';
import makeStyles from '@material-ui/core/styles/makeStyles';
import { Button, Container, TextField, Typography } from '@material-ui/core';
import { useAppDispatch, useAppSelector } from '../../store';
import { setAccount } from '../../state/account';
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
}));


function LoginPage() {
  const classes = useStyles();
  const account = useAppSelector(state => state.account);
  const dispatch = useAppDispatch();

  const handleClickCreate = useCallback(
    () => {
      const newAccountId = getAccountId();
      dispatch(setAccount(newAccountId));
    },
    [dispatch],
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
      {!account && (
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
      )}

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

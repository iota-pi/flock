import React, { ChangeEvent, useCallback, useState } from 'react';
import { useHistory } from 'react-router-dom';
import zxcvbn from 'zxcvbn';
import makeStyles from '@material-ui/core/styles/makeStyles';
import { Button, Container, fade, LinearProgress, TextField, Typography } from '@material-ui/core';
import { getPage } from '.';
import VaultAPI from '../../crypto/api';
import Vault, { registerVault } from '../../crypto/Vault';
import { getAccountId } from '../../utils';
import { useAppDispatch } from '../../store';
import { setAccount } from '../../state/account';

const MIN_PASSWORD_LENGTH = 10;
const MIN_PASSWORD_STRENGTH = 3;

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
    flexDirection: 'column',
    marginBottom: theme.spacing(2),
  },
  textField: {
    flexGrow: 1,
  },
  errorMessage: {
    marginTop: theme.spacing(2),
  },
  emphasis: {
    fontWeight: 500,
  },
  meterHolder: {
    marginTop: theme.spacing(1),
    marginBottom: theme.spacing(1),
    flexGrow: 1,
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
  },
  meter: {
    height: 2,
    flexGrow: 1,
    marginLeft: theme.spacing(2),

    '&$meterBad': {
      backgroundColor: fade(theme.palette.error.main, 0.5),
    },
    '&$meterOkay': {
      backgroundColor: fade(theme.palette.warning.main, 0.5),
    },
    '&$meterGood': {
      backgroundColor: fade(theme.palette.success.main, 0.5),
    },
  },
  meterBad: {
    backgroundColor: theme.palette.error.main,
  },
  meterOkay: {
    backgroundColor: theme.palette.warning.main,
  },
  meterGood: {
    backgroundColor: theme.palette.success.main,
  },
}));

const api = new VaultAPI();

function scorePassword(password: string): zxcvbn.ZXCVBNResult {
  const mainScore = zxcvbn(password);
  const harshScore = zxcvbn(password.substr(3));
  mainScore.score = Math.min(mainScore.score, harshScore.score) as zxcvbn.ZXCVBNScore;
  return mainScore;
}

function passwordScoreToWord(score: number) {
  const words = ['', 'very bad', 'not good', 'passable', 'okay'];
  return words[Math.min(score, words.length - 1)];
}

function passwordScoreToClass(score: number, classes: ReturnType<typeof useStyles>) {
  const words = [
    classes.meterBad,
    classes.meterBad,
    classes.meterBad,
    classes.meterOkay,
    classes.meterGood,
  ];
  return words[Math.min(score, words.length - 1)];
}


function CreateAccountPage() {
  const classes = useStyles();
  const dispatch = useAppDispatch();
  const history = useHistory();

  const [error, setError] = useState('');
  const [password, setPassword] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [passwordScore, setPasswordScore] = useState(0);

  const handleClickLogin = useCallback(
    () => history.push(getPage('login').path),
    [history],
  );
  const handleClickCreate = useCallback(
    async () => {
      const account = getAccountId();
      const vault = await Vault.create(account, password);
      const success = await api.createAccount({ account, authToken: vault.authToken });
      if (success) {
        dispatch(setAccount(account));
        registerVault(vault);
        setError('');
        history.push(getPage('login').path, { created: true });
      } else {
        setError('An error occured while creating your account.');
      }
    },
    [dispatch, history, password],
  );
  const handleChangePassword = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const newPassword = event.target.value;
      setPassword(newPassword);
      const passwordStrength = scorePassword(newPassword);
      setPasswordScore(Math.max(passwordStrength.score, 1));
      if (newPassword.length < MIN_PASSWORD_LENGTH) {
        setPasswordError(
          `Please use a password that is at least ${MIN_PASSWORD_LENGTH} characters long`,
        );
      } else if (passwordStrength.feedback.warning) {
        setPasswordError(passwordStrength.feedback.warning);
      } else if (passwordStrength.score < MIN_PASSWORD_STRENGTH) {
        setPasswordError('Please choose a stronger password');
      } else {
        setPasswordError('');
      }
    },
    [],
  );

  const validPassword = !!password && !passwordError;

  return (
    <Container className={classes.root}>
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
            value={password}
            onChange={handleChangePassword}
            fullWidth
            className={classes.textField}
          />

          <div className={classes.meterHolder}>
            <Typography>
              Password Strength:
              {' '}
              <span className={classes.emphasis}>
                {passwordScoreToWord(passwordScore)}
              </span>
            </Typography>

            <LinearProgress
              value={passwordScore * 25}
              variant="determinate"
              className={`${classes.meter} ${passwordScoreToClass(passwordScore, classes)}`}
              classes={{
                bar: passwordScoreToClass(passwordScore, classes),
              }}
            />
          </div>

          {passwordError && (
            <Typography color="error">
              {passwordError}
            </Typography>
          )}
        </div>

        <Button
          color="primary"
          variant="contained"
          size="large"
          onClick={handleClickCreate}
          disabled={!validPassword}
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
        <Typography variant="h5" gutterBottom>
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

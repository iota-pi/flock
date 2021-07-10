import React, { ChangeEvent, useCallback, useState } from 'react';
import { useHistory } from 'react-router-dom';
import zxcvbn from 'zxcvbn';
import {
  Button,
  CircularProgress,
  Container,
  fade,
  IconButton,
  InputAdornment,
  LinearProgress,
  makeStyles,
  TextField,
  Typography,
} from '@material-ui/core';
import VisibilityOff from '@material-ui/icons/VisibilityOff';
import Visibility from '@material-ui/icons/Visibility';
import { getPage } from '.';
import VaultAPI from '../../crypto/api';
import Vault from '../../crypto/Vault';
import { getAccountId } from '../../utils';

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
  buttonProgress: {
    position: 'absolute',
    top: '50%',
    left: '50%',
    marginTop: -12,
    marginLeft: -12,
  },
}));

const api = new VaultAPI();

function scorePassword(password: string): zxcvbn.ZXCVBNResult {
  const customDomainWords: string[] = [
    'flock',
    '1peter',
    'cross-code.org',
  ];
  const mainScore = zxcvbn(password, customDomainWords);
  const harshScore = zxcvbn(password.substr(3), customDomainWords);
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
  const history = useHistory();

  const [error, setError] = useState('');
  const [password, setPassword] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [passwordScore, setPasswordScore] = useState(0);
  const [waiting, setWaiting] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  const handleClickLogin = useCallback(
    () => history.push(getPage('login').path),
    [history],
  );
  const handleClickCreate = useCallback(
    async () => {
      setWaiting(true);
      try {
        const account = getAccountId();
        const vault = await Vault.create(account, password);
        const success = await api.createAccount({ account, authToken: vault.authToken });
        if (success) {
          setError('');
          history.push(getPage('login').path, { created: true, account });
        } else {
          setError('An error occured while creating your account.');
        }
      } catch (e) {
        console.error(e);
      }
      setWaiting(false);
    },
    [history, password],
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
  const handleClickVisibility = useCallback(
    () => setShowPassword(p => !p),
    [],
  );
  const handleMouseDownVisibility = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => event.stopPropagation(),
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
            type={showPassword ? 'text' : 'password'}
            autoComplete="current-password"
            value={password}
            onChange={handleChangePassword}
            fullWidth
            className={classes.textField}
            InputProps={{
              endAdornment: (
                <InputAdornment position="end">
                  <IconButton
                    onClick={handleClickVisibility}
                    onMouseDown={handleMouseDownVisibility}
                  >
                    {showPassword ? <VisibilityOff /> : <Visibility />}
                  </IconButton>
                </InputAdornment>
              ),
            }}
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
          disabled={!validPassword || waiting}
        >
          Create Account

          {waiting && (
            <CircularProgress
              className={classes.buttonProgress}
              size={24}
            />
          )}
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

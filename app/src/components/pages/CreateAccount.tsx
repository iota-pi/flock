import { ChangeEvent, MouseEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useHistory } from 'react-router-dom';
import zxcvbn from 'zxcvbn';
import {
  alpha,
  Button,
  CircularProgress,
  Collapse,
  Container,
  IconButton,
  InputAdornment,
  LinearProgress,
  styled,
  TextField,
  Typography,
} from '@material-ui/core';
import makeStyles from '@material-ui/styles/makeStyles';
import VisibilityOff from '@material-ui/icons/VisibilityOff';
import Visibility from '@material-ui/icons/Visibility';
import { getPage } from '.';
import VaultAPI from '../../crypto/api';
import Vault from '../../crypto/Vault';
import { getAccountId } from '../../utils';
import { useAppDispatch } from '../../store';
import { HomeIcon } from '../Icons';

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
    marginBottom: theme.spacing(1),
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
      backgroundColor: alpha(theme.palette.error.main, 0.5),
    },
    '&$meterOkay': {
      backgroundColor: alpha(theme.palette.warning.main, 0.5),
    },
    '&$meterGood': {
      backgroundColor: alpha(theme.palette.success.main, 0.5),
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

const Root = styled('div')({
  flexGrow: 1,
  overflowY: 'auto',
});
const MainContainer = styled(Container)(({ theme }) => ({
  padding: theme.spacing(4),
  position: 'relative',
}));
const CenterSection = styled('div')({
  alignItems: 'center',
  display: 'flex',
  flexDirection: 'column',
  flexGrow: 1,
  justifyContent: 'center',
});
const Section = styled('div')(({ theme }) => ({
  flexGrow: 1,
  paddingBottom: theme.spacing(8),
}));
const HomeIconContainer = styled('div')(({ theme }) => ({
  position: 'absolute',
  top: theme.spacing(2),
  left: theme.spacing(2),
}));

export interface ChecklistItem {
  id: string,
  description: string,
}

const api = new VaultAPI();

function scorePassword(password: string): zxcvbn.ZXCVBNResult {
  const customDomainWords: string[] = [
    'flock',
    '1peter',
    'cross-code.org',
    'gracious',
    'shepherd',
    'sheep',
    'field',
    'pasture',
    'among',
    'oversight',
    'overseer',
    'jesus',
    'correcthorse',
    'batterystaple',
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
  const dispatch = useAppDispatch();
  const history = useHistory();

  const account = useMemo(() => getAccountId(), []);

  const [error, setError] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [passwordScore, setPasswordScore] = useState(0);
  const [waiting, setWaiting] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  const handleClickHome = useCallback(
    () => history.push(getPage('welcome').path),
    [history],
  );

  const handleClickLogin = useCallback(
    () => history.push(getPage('login').path),
    [history],
  );
  const handleClickCreate = useCallback(
    async () => {
      setWaiting(true);
      try {
        const vault = await Vault.create(account, password, dispatch);
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
    [account, dispatch, history, password],
  );
  const handleChangePassword = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setPassword(event.target.value),
    [],
  );
  const handleChangePasswordConfirm = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setConfirmPassword(event.target.value),
    [],
  );
  const handleClickVisibility = useCallback(
    () => setShowPassword(p => !p),
    [],
  );
  const handleMouseDownVisibility = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => event.stopPropagation(),
    [],
  );

  useEffect(
    () => {
      if (password) {
        const passwordStrength = scorePassword(password);
        setPasswordScore(Math.max(passwordStrength.score, 1));
        if (password.length < MIN_PASSWORD_LENGTH) {
          setPasswordError(
            `Please use a password that is at least ${MIN_PASSWORD_LENGTH} characters long`,
          );
        } else if (passwordStrength.feedback.warning) {
          setPasswordError(passwordStrength.feedback.warning);
        } else if (passwordStrength.score < MIN_PASSWORD_STRENGTH) {
          setPasswordError('Please choose a stronger password');
        } else if (confirmPassword && confirmPassword !== password) {
          setPasswordError('The passwords you entered are different');
        } else {
          setPasswordError('');
        }
      }
    },
    [password, confirmPassword],
  );

  const validPassword = !!password && !!confirmPassword && !passwordError;

  return (
    <Root>
      <MainContainer maxWidth="sm">
        <HomeIconContainer>
          <IconButton
            data-cy="back-button"
            onClick={handleClickHome}
            size="large"
          >
            <HomeIcon />
          </IconButton>
        </HomeIconContainer>

        <CenterSection>
          <Link to={getPage('welcome').path}>
            <img
              src="/flock.png"
              alt=""
              width="300"
              height="300"
            />
          </Link>
        </CenterSection>

        <Section>
          <Typography variant="h4" gutterBottom>
            Create a New Account
          </Typography>

          <Typography paragraph>
            Please ensure that you
            {' '}
            <b>store your account ID and password</b>
            {' '}
            in a secure location.
          </Typography>

          <Typography paragraph>
            Because your data is client-side encrypted, it will not be possible to recover your data
            if you forget your account ID or password.
          </Typography>

          <TextField
            autoComplete="username"
            className={classes.textField}
            disabled
            fullWidth
            id="username"
            label="Account ID"
            value={account}
            variant="standard"
          />

          <TextField
            autoComplete="password"
            className={classes.textField}
            fullWidth
            id="password"
            InputProps={{
              endAdornment: (
                <InputAdornment position="end">
                  <IconButton
                    onClick={handleClickVisibility}
                    onMouseDown={handleMouseDownVisibility}
                    size="large"
                  >
                    {showPassword ? <VisibilityOff /> : <Visibility />}
                  </IconButton>
                </InputAdornment>
              ),
            }}
            label="Password"
            onChange={handleChangePassword}
            type={showPassword ? 'text' : 'password'}
            value={password}
            variant="standard"
          />

          <TextField
            autoComplete="confirm-password"
            className={classes.textField}
            fullWidth
            id="confirm-password"
            InputProps={{
              endAdornment: (
                <InputAdornment position="end">
                  <IconButton
                    onClick={handleClickVisibility}
                    onMouseDown={handleMouseDownVisibility}
                    size="large"
                  >
                    {showPassword ? <VisibilityOff /> : <Visibility />}
                  </IconButton>
                </InputAdornment>
              ),
            }}
            label="Confirm Password"
            onChange={handleChangePasswordConfirm}
            type={showPassword ? 'text' : 'password'}
            variant="standard"
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

          <Collapse in={!!passwordError}>
            <Typography color="error" paragraph>
              {passwordError}
              {/* non-breaking space maintains same base height, so smooths exit transition */}
              &nbsp;
            </Typography>
          </Collapse>

          <Button
            color="primary"
            data-cy="create-account"
            disabled={!validPassword || waiting}
            fullWidth
            onClick={handleClickCreate}
            size="large"
            variant="contained"
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
        </Section>

        <Section>
          <Typography variant="h5" gutterBottom>
            Login to Existing Account
          </Typography>

          <Button
            color="primary"
            fullWidth
            onClick={handleClickLogin}
            size="large"
            variant="contained"
          >
            Login
          </Button>
        </Section>
      </MainContainer>
    </Root>
  );
}

export default CreateAccountPage;

import { ChangeEvent, MouseEvent, useCallback, useEffect, useState } from 'react';
import { Link, useHistory, useLocation } from 'react-router-dom';
import {
  Alert,
  Button,
  Container,
  IconButton,
  InputAdornment,
  styled,
  TextField,
  Typography,
} from '@material-ui/core';
import makeStyles from '@material-ui/styles/makeStyles';
import Visibility from '@material-ui/icons/Visibility';
import VisibilityOff from '@material-ui/icons/VisibilityOff';
import { getPage } from '.';
import VaultAPI from '../../crypto/api';
import Vault from '../../crypto/Vault';
import { useAppDispatch } from '../../store';
import { setAccount } from '../../state/account';
import { setVault } from '../../state/vault';
import { HomeIcon } from '../Icons';


const useStyles = makeStyles(theme => ({
  alert: {
    marginBottom: theme.spacing(4),
  },
  textFieldHolder: {
    display: 'flex',
    flexGrow: 1,
  },
  textField: {
    marginBottom: theme.spacing(2),
  },
  errorMessage: {
    marginTop: theme.spacing(2),
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
const FormContent = styled('form')({
  display: 'flex',
  flexDirection: 'column',
  flexGrow: 1,
  minWidth: 300,
});
const HomeIconContainer = styled('div')(({ theme }) => ({
  position: 'absolute',
  top: theme.spacing(2),
  left: theme.spacing(2),
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
  const [showPassword, setShowPassword] = useState(false);

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

  const handleClickHome = useCallback(
    () => history.push(getPage('welcome').path),
    [history],
  );

  const handleClickLogin = useCallback(
    async () => {
      const vault = await Vault.create(accountInput, password, dispatch);
      const success = await api.checkPassword({
        account: accountInput,
        authToken: vault.authToken,
      });
      if (success) {
        dispatch(setVault(vault));
        dispatch(setAccount({ account: accountInput }));
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
  const handleClickVisibility = useCallback(
    () => setShowPassword(p => !p),
    [],
  );
  const handleMouseDownVisibility = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => event.stopPropagation(),
    [],
  );

  const justCreated = (location.state as { created: boolean } | undefined)?.created || false;

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
            Login
          </Typography>

          {justCreated && (
            <Alert severity="success" className={classes.alert}>
              Account successfully created!
              Please record your account ID and password and login again to continue.
            </Alert>
          )}

          <FormContent>
            <div className={classes.textFieldHolder}>
              <TextField
                autoComplete="username"
                autoFocus
                className={classes.textField}
                fullWidth
                id="username"
                label="Account ID"
                name="username"
                onChange={handleChangeAccount}
                value={accountInput}
                variant="standard" />
            </div>

            <div className={classes.textFieldHolder}>
              <TextField
                autoComplete="current-password"
                className={classes.textField}
                fullWidth
                id="current-password"
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
                name="password"
                onChange={handleChangePassword}
                type={showPassword ? 'text' : 'password'}
                value={password}
                variant="standard" />
            </div>

            <Button
              color="primary"
              data-cy="login"
              onClick={handleClickLogin}
              size="large"
              variant="contained"
            >
              Login
            </Button>

            {error && (
              <Typography paragraph color="error" className={classes.errorMessage}>
                {error}
              </Typography>
            )}
          </FormContent>
        </Section>

        <Section>
          <FormContent>
            <Typography
              gutterBottom
              variant="h5"
            >
              Create a New Account
            </Typography>

            <Button
              color="primary"
              data-cy="create-account"
              onClick={handleClickCreate}
              size="large"
              variant="contained"
            >
              Create Account
            </Button>
          </FormContent>
        </Section>
      </MainContainer>
    </Root>
  );
}

export default LoginPage;

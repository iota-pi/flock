import { ChangeEvent, MouseEvent, useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  Alert,
  Box,
  Button,
  Container,
  IconButton,
  InputAdornment,
  styled,
  TextField,
  Typography,
} from '@mui/material'
import Visibility from '@mui/icons-material/Visibility'
import VisibilityOff from '@mui/icons-material/VisibilityOff'
import { getPage } from '.'
import { useAppDispatch, useAppSelector } from '../../store'
import { setAccount } from '../../state/account'
import { HomeIcon } from '../Icons'
import { loginVault } from '../../api/Vault'
import { vaultGetSalt } from '../../api/VaultAPI'
import { setUi } from '../../state/ui'


const Root = styled('div')({
  flexGrow: 1,
  overflowY: 'auto',
})
const MainContainer = styled(Container)(({ theme }) => ({
  padding: theme.spacing(4),
  position: 'relative',
}))
const CenterSection = styled('div')({
  alignItems: 'center',
  display: 'flex',
  flexDirection: 'column',
  flexGrow: 1,
  justifyContent: 'center',
})
const Section = styled('div')(({ theme }) => ({
  flexGrow: 1,
  paddingBottom: theme.spacing(8),
}))
const FormContent = styled('form')({
  display: 'flex',
  flexDirection: 'column',
  flexGrow: 1,
  minWidth: 300,
})
const HomeIconContainer = styled('div')(({ theme }) => ({
  position: 'absolute',
  top: theme.spacing(2),
  left: theme.spacing(2),
}))


function LoginPage() {
  const dispatch = useAppDispatch()
  const navigate = useNavigate()

  const [error, setError] = useState('')
  const [password, setPassword] = useState('')
  const [accountInput, setAccountInput] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const createdAccountId = useAppSelector(state => state.account.account)
  const justCreatedAccount = useAppSelector(state => state.ui.justCreatedAccount)

  useEffect(
    () => {
      if (justCreatedAccount) {
        setAccountInput(createdAccountId)
        dispatch(setUi({ justCreatedAccount: false }))
      }
    },
    [createdAccountId, dispatch, justCreatedAccount],
  )

  const handleClickHome = useCallback(
    () => navigate(getPage('welcome').path),
    [navigate],
  )

  const handleClickLogin = useCallback(
    async () => {
      dispatch(setAccount({ account: accountInput }))
      const salt = await vaultGetSalt().catch(() => '')
      if (salt.length) {
        try {
          await loginVault({ password, salt })
          dispatch(setAccount({ loggedIn: true }))
          navigate(getPage('people').path)
        } catch (error) {
          console.error('Error during vault initialization:', error)
          dispatch(setAccount({ account: '' }))
          setError('Login failed.')
        }
      } else {
        dispatch(setAccount({ account: '' }))
        setError('Could not find matching account ID and password.')
      }
    },
    [accountInput, dispatch, navigate, password],
  )
  const handleClickCreate = useCallback(
    () => {
      navigate(getPage('signup').path)
    },
    [navigate],
  )
  const handleChangeAccount = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setAccountInput(event.target.value),
    [],
  )
  const handleChangePassword = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setPassword(event.target.value),
    [],
  )
  const handleClickVisibility = useCallback(
    () => setShowPassword(p => !p),
    [],
  )
  const handleMouseDownVisibility = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => event.stopPropagation(),
    [],
  )

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

          {justCreatedAccount && (
            <Box mb={4}>
              <Alert severity="success">
                Account successfully created!
                Please record your account ID and password and login again to continue.
              </Alert>
            </Box>
          )}

          <FormContent>
            <Box display="flex" flexGrow={1} mb={2}>
              <TextField
                autoComplete="username"
                autoFocus
                fullWidth
                id="username"
                label="Account ID"
                name="username"
                onChange={handleChangeAccount}
                value={accountInput}
                variant="standard"
              />
            </Box>

            <Box display="flex" flexGrow={1} mb={2}>
              <TextField
                autoComplete="current-password"
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
                variant="standard"
              />
            </Box>

            <Button
              color="primary"
              data-cy="login"
              disabled={!accountInput || !password}
              onClick={handleClickLogin}
              size="large"
              variant="contained"
            >
              Login
            </Button>

            {error && (
              <Typography paragraph color="error" mt={2}>
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
  )
}

export default LoginPage

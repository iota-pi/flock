import { ChangeEvent, MouseEvent, useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router'
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
import { ROUTES } from './routes'
import { useUiStore } from '../../state/uiStore'
import { HomeIcon, PasswordIcon, PersonIcon } from '../Icons'
import { getSalt, loginVault } from '../../api/vault'
import { useAuth } from '../../hooks/useAuth'
import { useAuthStore } from '../../state/authStore'


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
  const setUi = useUiStore(state => state.setUi)
  const navigate = useNavigate()

  const [error, setError] = useState('')
  const [password, setPassword] = useState('')
  const [accountInput, setAccountInput] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [loading, setLoading] = useState(false)
  const { account: createdAccountId } = useAuth()
  const setAccount = useAuthStore(state => state.setAccount)
  const justCreatedAccount = useUiStore(state => state.justCreatedAccount)

  useEffect(
    () => {
      if (justCreatedAccount) {
        setAccountInput(createdAccountId)
        setUi({ justCreatedAccount: false })
      }
    },
    [createdAccountId, justCreatedAccount, setUi],
  )

  const handleClickHome = useCallback(
    () => navigate(ROUTES.welcome.path),
    [navigate],
  )


  const handleClickLogin = useCallback(
    async () => {
      setLoading(true)
      setError('')
      setAccount({ account: accountInput })
      const salt = await getSalt().catch(() => '')
      if (salt.length) {
        try {
          await loginVault({ password, salt })
          setAccount({ loggedIn: true })
          navigate(ROUTES.prayer.path)
        } catch (error) {
          console.error('Error during vault initialization:', error)
          setAccount({ account: '' })
          setError('Login failed.')
        } finally {
          setLoading(false)
        }
      } else {
        setAccount({ account: '' })
        setError('Could not find matching account ID and password.')
        setLoading(false)
      }
    },
    [accountInput, navigate, password, setAccount],
  )
  const handleClickCreate = useCallback(
    () => {
      navigate(ROUTES.signup.path)
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
          <Link to={ROUTES.welcome.path}>
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
                slotProps={{
                  input: {
                    startAdornment: (
                      <InputAdornment position="start">
                        <PersonIcon />
                      </InputAdornment>
                    ),
                  }
                }}
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
                slotProps={{
                  input: {
                    startAdornment: (
                      <InputAdornment position="start">
                        <PasswordIcon />
                      </InputAdornment>
                    ),
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
                  }
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
              loading={loading}
              onClick={handleClickLogin}
              size="large"
              variant="contained"
            >
              Login
            </Button>

            {error && (
              <Typography color="error" mt={2}>
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

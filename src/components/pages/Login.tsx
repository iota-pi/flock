import { ChangeEvent, MouseEvent, useCallback, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Container from '@mui/material/Container'
import IconButton from '@mui/material/IconButton'
import InputAdornment from '@mui/material/InputAdornment'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { styled } from '@mui/material/styles'

import { ROUTES } from './routes'
import { resolveRedirectRoute, type RedirectRouteState } from './redirectUtils'
import { useAppStore } from 'src/state/store'
import {
  HomeIcon,
  PasswordIcon,
  PersonIcon,
  VisibilityIcon,
  VisibilityOffIcon,
} from '../Icons'
import { getSecurityParams, loginVault } from 'src/api/vault'


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
  const setUi = useAppStore(state => state.setUi)
  const navigate = useNavigate()
  const location = useLocation()

  const createdAccountId = useAppStore(state => state.account)
  const justCreatedAccount = useAppStore(state => state.justCreatedAccount)
  const updateAuth = useAppStore(state => state.updateAuth)

  const [error, setError] = useState('')
  const [password, setPassword] = useState('')
  const [accountInput, setAccountInput] = useState(() => createdAccountId || '')
  const [showPassword, setShowPassword] = useState(false)
  const [loading, setLoading] = useState(false)

  const handleClickHome = useCallback(
    () => navigate(ROUTES.welcome.path),
    [navigate],
  )

  const handleClickLogin = useCallback(
    async () => {
      setLoading(true)
      setError('')
      updateAuth({ account: accountInput })
      const securityParams = await getSecurityParams(accountInput).catch(
        (err): { salt: string, iterations?: number, saltVersion?: number } => {
          console.error('[Login] getSecurityParams failed', err)
          return { salt: '', iterations: undefined, saltVersion: undefined }
        }
      )
      if (securityParams.salt.length) {
        try {
          await loginVault({
            account: accountInput,
            password,
            salt: securityParams.salt,
            iterations: securityParams.iterations,
            saltVersion: securityParams.saltVersion,
          })
          updateAuth({ loggedIn: true })
          setUi({ justCreatedAccount: false })

          const nextRoute = resolveRedirectRoute(
            location.state as RedirectRouteState | null,
            ROUTES.prayer.path,
            location.pathname,
          )

          navigate(nextRoute)
        } catch (error) {
          console.error('Error during vault initialization:', error)
          updateAuth({ account: '' })
          setError('Login failed.')
        } finally {
          setLoading(false)
        }
      } else {
        updateAuth({ account: '' })
        setError('Could not find matching account ID and password.')
        setLoading(false)
      }
    },
    [accountInput, location.state, location.pathname, navigate, password, setUi, updateAuth],
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
            <Box sx={{
              mb: 4
            }}>
              <Alert severity="success">
                Account successfully created!
                Please record your account ID and password and login again to continue.
              </Alert>
            </Box>
          )}

          <FormContent>
            <Box
              sx={{
                display: "flex",
                flexGrow: 1,
                mb: 2
              }}>
              <TextField
                autoComplete="username"
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

            <Box
              sx={{
                display: "flex",
                flexGrow: 1,
                mb: 2
              }}>
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
                          {showPassword ? <VisibilityOffIcon /> : <VisibilityIcon />}
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
              <Typography color="error" sx={{
                mt: 2
              }}>
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

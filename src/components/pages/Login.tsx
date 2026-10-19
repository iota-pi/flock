import { ChangeEvent, MouseEvent, useCallback, useEffect, useRef, useState } from 'react'
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
import { checkForAppUpdate, whileLoggingIn } from 'src/app/appUpdate'
import {
  FingerprintIcon,
  HomeIcon,
  PasswordIcon,
  PersonIcon,
  VisibilityIcon,
  VisibilityOffIcon,
} from '../Icons'
import {
  getSecurityParams,
  loginVault,
  hasBiometricData,
  readBiometricData,
  readStoredMetadata,
  unlockWithBiometrics,
  getBiometricLabel,
  StaleBiometricKeyError,
  UnsupportedKeyDerivationError,
  type KdfParams,
} from '@vault/client'
import { goToMigration, isMigrationDeferred, MIN_ACCOUNT_DATA_VERSION } from 'src/migrate/detection'

/** How long to wait for the server's login parameters when this device has them cached */
/** Shown when an account needs the migration app but the server can't be reached */
const ACCOUNT_UPDATE_NEEDS_SERVER =
  "This account's security settings need updating, which needs a connection to the server. " +
  'Check your internet connection and try again.'

const CACHED_PARAMS_WAIT_MS = 3000


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
  const setMessage = useAppStore(state => state.setMessage)

  const [error, setError] = useState('')
  const [password, setPassword] = useState('')
  const [defaultAccount] = useState(() => {
    if (createdAccountId) return createdAccountId
    const biometricData = readBiometricData()
    if (biometricData?.account) return biometricData.account
    const storedMeta = readStoredMetadata()
    if (storedMeta?.account) return storedMeta.account
    return ''
  })
  const [accountInput, setAccountInput] = useState(defaultAccount)
  const [showPassword, setShowPassword] = useState(false)
  const [showPasswordForm, setShowPasswordForm] = useState(false)
  const [loading, setLoading] = useState(false)
  const biometricLabel = getBiometricLabel()
  const [wasManuallyLocked] = useState(() => {
    const flag = sessionStorage.getItem('flock-manual-lock') === 'true'
    if (flag) {
      sessionStorage.removeItem('flock-manual-lock')
    }
    return flag
  })
  const hasAutoPromptedRef = useRef(false)

  // Pick up a new version of the app before signing in: applying it reloads the page, which would
  // lock a signed-in session (see appUpdate.ts)
  useEffect(() => {
    void checkForAppUpdate()
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void checkForAppUpdate()
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange)
  }, [])

  const handleClickHome = useCallback(
    () => navigate(ROUTES.welcome.path),
    [navigate],
  )

  const handleClickLogin = useCallback(
    async () => {
      setLoading(true)
      setError('')
      updateAuth({ account: accountInput })
      let securityParams: { salt: string; iterations?: number; saltVersion?: number; kdf?: KdfParams }
      let reachedServer = false
      const cached = readStoredMetadata()
      const cachedParams = cached?.salt && cached.account === accountInput
        ? { salt: cached.salt, iterations: cached.iterations, saltVersion: cached.saltVersion, kdf: cached.kdf }
        : null
      try {
        // With the parameters cached, a slow server doesn't hold up logging in
        const paramsRequest = getSecurityParams(accountInput)
        paramsRequest.catch(() => undefined)
        const params = cachedParams
          ? await Promise.race([
            paramsRequest,
            new Promise<never>((_resolve, reject) => {
              setTimeout(() => reject(new Error('The server is slow to respond')), CACHED_PARAMS_WAIT_MS)
            }),
          ])
          : await paramsRequest
        // An account below the minimum level holds data this app no longer reads. One still on
        // PBKDF2 always goes: only the migration app derives PBKDF2 keys.
        if (!params.kdf || (params.dataVersion < MIN_ACCOUNT_DATA_VERSION && !isMigrationDeferred(accountInput))) {
          goToMigration(accountInput)
          return
        }
        securityParams = params
        reachedServer = true
      } catch (err) {
        console.warn('[Login] getSecurityParams failed (offline or network error), checking cached metadata:', err)
        securityParams = cachedParams ?? { salt: '', iterations: undefined, saltVersion: undefined }
      }

      if (securityParams.salt.length) {
        try {
          const { keyDerivationUpgraded, biometricsCleared } = await whileLoggingIn(async () => {
            const result = await loginVault({
              account: accountInput,
              password,
              salt: securityParams.salt,
              kdf: securityParams.kdf,
              iterations: securityParams.iterations,
              saltVersion: securityParams.saltVersion,
            })
            updateAuth({ loggedIn: true })
            return result
          })
          setUi({ justCreatedAccount: false })
          if (keyDerivationUpgraded) {
            let message = 'We upgraded the encryption on your account, so your other devices will ask you to log in again.'
            if (biometricsCleared) {
              message += ` ${biometricLabel} unlock was turned off on this device; you can re-enable it in Settings.`
            }
            setMessage({ severity: 'info', message })
          }

          const nextRoute = resolveRedirectRoute(
            location.state as RedirectRouteState | null,
            ROUTES.prayer.path,
            location.pathname,
          )

          navigate(nextRoute)
        } catch (error) {
          if (error instanceof UnsupportedKeyDerivationError) {
            // Cached key derivation parameters this app no longer accepts (PBKDF2, a legacy salt).
            // Only the migration app reads them, and it needs the server, so without the server
            // there's nothing to send the user to yet.
            if (!reachedServer) {
              updateAuth({ account: '' })
              setError(ACCOUNT_UPDATE_NEEDS_SERVER)
              return
            }
            goToMigration(accountInput)
            return
          }
          console.error('Error during vault initialization:', error)
          updateAuth({ account: '' })
          setError(error instanceof Error ? error.message : 'Login failed.')
        } finally {
          setLoading(false)
        }
      } else {
        updateAuth({ account: '' })
        setError('Could not find matching account ID and password.')
        setLoading(false)
      }
    },
    [accountInput, biometricLabel, location.state, location.pathname, navigate, password, setMessage, setUi, updateAuth],
  )
  const handleClickBiometricUnlock = useCallback(
    async () => {
      setLoading(true)
      setError('')
      try {
        updateAuth({ account: accountInput })
        await whileLoggingIn(async () => {
          await unlockWithBiometrics(accountInput)
          updateAuth({ loggedIn: true })
        })
        setUi({ justCreatedAccount: false })

        const nextRoute = resolveRedirectRoute(
          location.state as RedirectRouteState | null,
          ROUTES.prayer.path,
          location.pathname,
        )

        navigate(nextRoute)
      } catch (err: unknown) {
        console.error('[Login] Biometric unlock failed', err)
        setShowPasswordForm(true)
        if (err instanceof StaleBiometricKeyError) {
          setError(
            `Your password or account security changed on another device, so ${biometricLabel} unlock was turned off. `
            + 'Please log in with your password.',
          )
        } else if (err instanceof Error && err.name === 'NotAllowedError') {
          setError(`${biometricLabel} unlock was cancelled. Enter your password instead or try again.`)
        } else {
          setError(`${biometricLabel} unlock failed. Please use your password.`)
        }
      } finally {
        setLoading(false)
      }
    },
    [accountInput, biometricLabel, location.state, location.pathname, navigate, setUi, updateAuth],
  )

  useEffect(() => {
    if (hasBiometricData() && accountInput && !justCreatedAccount && !hasAutoPromptedRef.current) {
      if (wasManuallyLocked) {
        hasAutoPromptedRef.current = true
        return
      }

      if (document.visibilityState === 'hidden') {
        const handleVisibilityChange = () => {
          if (document.visibilityState === 'visible' && !hasAutoPromptedRef.current) {
            hasAutoPromptedRef.current = true
            document.removeEventListener('visibilitychange', handleVisibilityChange)
            queueMicrotask(() => {
              void handleClickBiometricUnlock()
            })
          }
        }
        document.addEventListener('visibilitychange', handleVisibilityChange)
        return () => {
          document.removeEventListener('visibilitychange', handleVisibilityChange)
        }
      } else {
        hasAutoPromptedRef.current = true
        queueMicrotask(() => {
          void handleClickBiometricUnlock()
        })
      }
    }
  }, [accountInput, justCreatedAccount, handleClickBiometricUnlock, wasManuallyLocked])

  const handleClickCreate = useCallback(
    () => {
      navigate(ROUTES.signup.path)
    },
    [navigate],
  )
  const handleChangeAccount = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      setAccountInput(event.target.value)
      setError('')
    },
    [],
  )
  const handleChangePassword = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      setPassword(event.target.value)
      setError('')
    },
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

  const canUseBiometrics = hasBiometricData() && Boolean(accountInput)

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

          {!justCreatedAccount && (
            <Typography variant="h4" gutterBottom align="center">
              {defaultAccount ? 'Locked' : 'Login'}
            </Typography>
          )}

          {canUseBiometrics && !showPasswordForm ? (
            <Box sx={{ mb: 4 }}>
              <Button
                color="primary"
                data-cy="biometric-login"
                disabled={loading}
                fullWidth
                onClick={handleClickBiometricUnlock}
                size="large"
                startIcon={<FingerprintIcon />}
                variant="contained"
              >
                Unlock with {biometricLabel}
              </Button>

              <Box sx={{ mt: 2, textAlign: 'center' }}>
                <Button
                  color="primary"
                  fullWidth
                  onClick={() => setShowPasswordForm(true)}
                  variant="text"
                >
                  Login with password instead
                </Button>
              </Box>
            </Box>
          ) : (
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

              {canUseBiometrics && (
                <Box sx={{ mt: 2, textAlign: 'center' }}>
                  <Button
                    color="primary"
                    disabled={loading}
                    fullWidth
                    startIcon={<FingerprintIcon />}
                    onClick={handleClickBiometricUnlock}
                    variant="text"
                  >
                    Unlock with {biometricLabel} instead
                  </Button>
                </Box>
              )}
            </FormContent>
          )}

          {error && (
            <Box sx={{ mt: 3 }}>
              <Alert
                severity="error"
                onClose={() => setError('')}
                data-cy="login-error"
              >
                {error}
              </Alert>
            </Box>
          )}
        </Section>

        <Section>
          <FormContent>
            <Button
              color="primary"
              data-cy="create-account"
              onClick={handleClickCreate}
              size="large"
              variant="text"
            >
              Create a New Account
            </Button>
          </FormContent>
        </Section>
      </MainContainer>
    </Root>
  )
}

export default LoginPage

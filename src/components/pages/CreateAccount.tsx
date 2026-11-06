import { type MouseEvent, useCallback, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { useForm, useWatch } from 'react-hook-form'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Collapse from '@mui/material/Collapse'
import Container from '@mui/material/Container'
import IconButton from '@mui/material/IconButton'
import InputAdornment from '@mui/material/InputAdornment'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { styled } from '@mui/material/styles'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'

import { ROUTES } from './routes'
import {
  HomeIcon,
  PasswordIcon,
  VisibilityIcon,
  VisibilityOffIcon,
} from '../Icons'
import { createVaultAccount } from '@vault/client'
import { createLogger } from 'src/utils/logger'
import { usePasswordStrength } from 'src/hooks/usePasswordStrength'
import PasswordMeter from '../PasswordMeter'
import AccountCreatedDialog from '../dialogs/AccountCreatedDialog'
import { useAppStore } from 'src/state/store'

const log = createLogger('CreateAccount')


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
const HomeIconContainer = styled('div')(({ theme }) => ({
  position: 'absolute',
  top: theme.spacing(2),
  left: theme.spacing(2),
}))
const StyledTextField = styled(TextField)(({ theme }) => ({
  marginBottom: theme.spacing(1),
}))

const CreateAccountFormSchema = z.object({
  password: z.string().min(1, 'Password is required'),
})

type CreateAccountFormInput = z.input<typeof CreateAccountFormSchema>

function CreateAccountPage() {
  const setUi = useAppStore(state => state.setUi)
  const navigate = useNavigate()

  const [error, setError] = useState('')
  const [waiting, setWaiting] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [showCreatedAccountDialog, setShowCreatedAccountDialog] = useState(false)
  const [newAccount, setNewAccount] = useState('')
  const updateAuth = useAppStore(state => state.updateAuth)

  const {
    register,
    control,
    formState: { errors },
  } = useForm<CreateAccountFormInput>({
    resolver: zodResolver(CreateAccountFormSchema),
    mode: 'onChange',
    defaultValues: {
      password: '',
    },
  })

  const password = useWatch({ control, name: 'password' }) || ''
  const { score: passwordScore, error: passwordError } = usePasswordStrength(password)

  const handleClickHome = useCallback(
    () => navigate(ROUTES.welcome.path),
    [navigate],
  )

  const handleClickLogin = useCallback(
    () => navigate(ROUTES.login.path),
    [navigate],
  )

  const handleClickCreate = useCallback(
    async () => {
      setWaiting(true)
      try {
        const account = await createVaultAccount(password)
        if (account.length > 0) {
          updateAuth({ account })
          setNewAccount(account)
          setShowCreatedAccountDialog(true)
        } else {
          setError('An error occured while creating your account.')
        }
      } catch (e) {
        log.error(e)
        setError('An error occured while creating your account.')
      }
      setWaiting(false)
    },
    [password, updateAuth],
  )

  const handleCloseCreatedAccountDialog = useCallback(
    () => {
      setShowCreatedAccountDialog(false)
      setUi({ justCreatedAccount: true })
      navigate(ROUTES.login.path)
    },
    [navigate, setUi],
  )

  const handleClickVisibility = useCallback(
    () => setShowPassword(p => !p),
    [],
  )
  const handleMouseDownVisibility = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => event.stopPropagation(),
    [],
  )

  const validPassword = !!password && !passwordError

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
            Create a New Account
          </Typography>

          <Typography>
            Flock encrypts your data on this device before it syncs, so only you can read it.
            That also means
            {' '}
            <b>nobody, including us, can reset your password or look up your account ID</b>.
          </Typography>

          <Typography>
            Use a password manager to create and save your password.
            Once you&apos;ve set your password,
            you&apos;ll get an account ID: save it
            {' '}
            <b>in the same entry as the username</b>.
          </Typography>

          <form>
            {/* Hidden username field for accessibility / password managers */}
            <input
              type="text"
              name="username"
              autoComplete="username"
              style={{ display: 'none' }}
            />
            <StyledTextField
              autoComplete="new-password"
              error={!!errors.password}
              fullWidth
              helperText={errors.password?.message || ' '}
              id="password"
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
              type={showPassword ? 'text' : 'password'}
              variant="standard"
              {...register('password')}
            />

            <PasswordMeter score={passwordScore} />

            <Collapse in={!!passwordError}>
              <Typography color="error">
                {passwordError}
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
              loading={waiting}
            >
              Create Account
            </Button>

            {error && (
              <Box sx={{ mt: 3 }}>
                <Alert
                  severity="error"
                  onClose={() => setError('')}
                >
                  {error}
                </Alert>
              </Box>
            )}
          </form>
        </Section>

        <Section>
          <Button
            color="primary"
            fullWidth
            onClick={handleClickLogin}
            size="large"
            variant="text"
          >
            Login to Existing Account
          </Button>
        </Section>

        <AccountCreatedDialog
          open={showCreatedAccountDialog}
          accountId={newAccount}
          onContinue={handleCloseCreatedAccountDialog}
        />
      </MainContainer>
    </Root>
  )
}

export default CreateAccountPage

import { MouseEvent, useCallback, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import {
  Button,
  Collapse,
  Container,
  IconButton,
  InputAdornment,
  styled,
  TextField,
  Typography,
} from '@mui/material'
import VisibilityOff from '@mui/icons-material/VisibilityOff'
import Visibility from '@mui/icons-material/Visibility'
import { zodResolver } from '@hookform/resolvers/zod'
import { useForm, useWatch } from 'react-hook-form'
import { z } from 'zod'
import { ROUTES } from './routes'
import { HomeIcon, PasswordIcon } from '../Icons'
import { useUiStore } from '../../state/uiStore'
import { createAccount, initialiseVault } from '../../api/vault'
import { generateSalt } from '../../api/vault/crypto'
import { usePasswordStrength } from '../../hooks/usePasswordStrength'
import PasswordMeter from '../PasswordMeter'
import AccountCreatedDialog from '../dialogs/AccountCreatedDialog'
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
  const setUi = useUiStore(state => state.setUi)
  const navigate = useNavigate()

  const [error, setError] = useState('')
  const [waiting, setWaiting] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [showCreatedAccountDialog, setShowCreatedAccountDialog] = useState(false)
  const [newAccount, setNewAccount] = useState('')
  const updateAuth = useAuthStore(state => state.updateAuth)

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
        const salt = generateSalt()
        const authToken = await initialiseVault({
          password,
          salt,
          isNewAccount: true,
        })
        const { account } = await createAccount({ salt, authToken })
        if (account.length > 0) {
          updateAuth({ account })
          setNewAccount(account)
          setShowCreatedAccountDialog(true)
        } else {
          setError('An error occured while creating your account.')
        }
      } catch (e) {
        console.error(e)
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
            Please ensure that you
            {' '}
            <b>store your account ID and password</b>
            {' '}
            in a secure location.
          </Typography>

          <Typography>
            Because your data is client-side encrypted, it will not be possible to recover your data
            if you forget your account ID or password.
          </Typography>

          <form>
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
                        {showPassword ? <VisibilityOff /> : <Visibility />}
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
              <Typography color="error" sx={{
                mt: 2
              }}>
                {error}
              </Typography>
            )}
          </form>
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

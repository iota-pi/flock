import { ChangeEvent, MouseEvent, useCallback, useState } from 'react'
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
import { getPage } from '.'
import { HomeIcon, PasswordIcon } from '../Icons'
import { useAppDispatch } from '../../store'
import { setUi } from '../../state/ui'
import { setAccount } from '../../state/account'
import { createAccount, initialiseVault } from '../../api/VaultLazy'
import { getSalt } from '../../api/crypto-utils'
import { usePasswordStrength } from '../../hooks/usePasswordStrength'
import PasswordMeter from '../PasswordMeter'
import AccountCreatedDialog from '../dialogs/AccountCreatedDialog'

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

export interface ChecklistItem {
  id: string,
  description: string,
}

function CreateAccountPage() {
  const dispatch = useAppDispatch()
  const navigate = useNavigate()

  const [error, setError] = useState('')
  const [password, setPassword] = useState('')
  const [waiting, setWaiting] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [showCreatedAccountDialog, setShowCreatedAccountDialog] = useState(false)
  const [newAccount, setNewAccount] = useState('')

  const { score: passwordScore, error: passwordError } = usePasswordStrength(password)

  const handleClickHome = useCallback(
    () => navigate(getPage('welcome').path),
    [navigate],
  )

  const handleClickLogin = useCallback(
    () => navigate(getPage('login').path),
    [navigate],
  )

  const handleChangePassword = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setPassword(event.target.value),
    [],
  )

  const handleClickCreate = useCallback(
    async () => {
      setWaiting(true)
      try {
        const salt = getSalt()
        const authToken = await initialiseVault({
          password,
          salt,
          isNewAccount: true,
        })
        const { account } = await createAccount({ salt, authToken })
        if (account.length > 0) {
          dispatch(setAccount({ account }))
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
    [dispatch, navigate, password],
  )

  const handleCloseCreatedAccountDialog = useCallback(
    () => {
      setShowCreatedAccountDialog(false)
      dispatch(setUi({ justCreatedAccount: true }))
      navigate(getPage('login').path)
    },
    [dispatch, navigate],
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

          <form>
            <StyledTextField
              autoComplete="new-password"
              fullWidth
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
              onChange={handleChangePassword}
              type={showPassword ? 'text' : 'password'}
              value={password}
              variant="standard"
            />

            <PasswordMeter score={passwordScore} />

            <Collapse in={!!passwordError}>
              <Typography color="error" paragraph>
                {passwordError}
                {/* non-breaking space preserves height, smoothing exit transition */}
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
              <Typography paragraph color="error" mt={2}>
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

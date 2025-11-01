import { ChangeEvent, MouseEvent, useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import zxcvbn from 'zxcvbn'
import {
  alpha,
  Box,
  Button,
  Checkbox,
  Collapse,
  Container,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  FormGroup,
  IconButton,
  InputAdornment,
  LinearProgress,
  styled,
  TextField,
  Theme,
  Typography,
} from '@mui/material'
import { LoadingButton } from '@mui/lab'
import VisibilityOff from '@mui/icons-material/VisibilityOff'
import Visibility from '@mui/icons-material/Visibility'
import { getPage } from '.'
import { HomeIcon, SuccessIcon } from '../Icons'
import { useAppDispatch } from '../../store'
import customDomainWords from '../../utils/customDomainWords'
import InlineText from '../InlineText'
import { setUi } from '../../state/ui'
import { setAccount } from '../../state/account'
import { initialiseVault } from '../../api/Vault'
import { vaultCreateAccount } from '../../api/VaultAPI'

const MIN_PASSWORD_LENGTH = 10
const MIN_PASSWORD_STRENGTH = 3

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
const MeterHolder = styled('div')(({ theme }) => ({
  marginTop: theme.spacing(1),
  marginBottom: theme.spacing(1),
  flexGrow: 1,
  display: 'flex',
  flexDirection: 'row',
  alignItems: 'center',
}))
const PasswordMeter = styled(LinearProgress)<{ strength: number }>(({ strength, theme }) => {
  const colour = passwordScoreToColour(strength, theme)
  return {
    height: 2,
    flexGrow: 1,
    marginLeft: theme.spacing(2),

    backgroundColor: alpha(colour, 0.5),
    '& .MuiLinearProgress-bar': {
      backgroundColor: colour,
    },
  }
})

export interface ChecklistItem {
  id: string,
  description: string,
}

function scorePassword(password: string): zxcvbn.ZXCVBNResult {
  const mainScore = zxcvbn(password, customDomainWords)
  const harshScore = zxcvbn(password.slice(3), customDomainWords)
  mainScore.score = Math.min(mainScore.score, harshScore.score) as zxcvbn.ZXCVBNScore
  return mainScore
}

function passwordScoreToWord(score: number) {
  const words = ['', 'very bad', 'not good', 'passable', 'okay']
  return words[Math.min(score, words.length - 1)]
}

function passwordScoreToColour(score: number, theme: Theme) {
  const words = [
    theme.palette.error.main,
    theme.palette.error.main,
    theme.palette.error.main,
    theme.palette.warning.main,
    theme.palette.success.main,
  ]
  return words[Math.min(score, words.length - 1)]
}


function CreateAccountPage() {
  const dispatch = useAppDispatch()
  const navigate = useNavigate()

  const [error, setError] = useState('')
  const [password, setPassword] = useState('')
  const [passwordError, setPasswordError] = useState('')
  const [passwordScore, setPasswordScore] = useState(0)
  const [waiting, setWaiting] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [showCreatedAccountDialog, setShowCreatedAccountDialog] = useState(false)
  const [agreement, setAgreement] = useState(false)
  const [newAccount, setNewAccount] = useState('')

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
        const { account, salt, tempAuthToken } = await vaultCreateAccount()
        if (account.length > 0) {
          dispatch(setAccount({ account }))
          await initialiseVault({
            password,
            salt,
            isNewAccount: true,
            tempAuthToken,
          })
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

  function handleChangeAgreement(event: ChangeEvent<HTMLInputElement>): void {
    setAgreement(event.target.checked)
  }

  const handleCloseCreatedAccountDialog = useCallback(
    () => {
      if (!agreement) {
        return
      }
      setShowCreatedAccountDialog(false)
      dispatch(setUi({ justCreatedAccount: true }))
      navigate(getPage('login').path)
    },
    [agreement],
  )

  const handleClickVisibility = useCallback(
    () => setShowPassword(p => !p),
    [],
  )
  const handleMouseDownVisibility = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => event.stopPropagation(),
    [],
  )

  useEffect(
    () => {
      if (password) {
        const passwordStrength = scorePassword(password)
        setPasswordScore(Math.max(passwordStrength.score, 1))
        if (password.length < MIN_PASSWORD_LENGTH) {
          setPasswordError(
            `Please use a password that is at least ${MIN_PASSWORD_LENGTH} characters long`,
          )
        } else if (passwordStrength.feedback.warning) {
          setPasswordError(passwordStrength.feedback.warning)
        } else if (passwordStrength.score < MIN_PASSWORD_STRENGTH) {
          setPasswordError('Please choose a stronger password')
        } else {
          setPasswordError('')
        }
      }
    },
    [password],
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

            <MeterHolder>
              <Typography>
                Password Strength:
                {' '}
                <InlineText fontWeight={500}>
                  {passwordScoreToWord(passwordScore)}
                </InlineText>
              </Typography>

              <PasswordMeter
                strength={passwordScore}
                value={passwordScore * 25}
                variant="determinate"
              />
            </MeterHolder>

            <Collapse in={!!passwordError}>
              <Typography color="error" paragraph>
                {passwordError}
                {/* non-breaking space preserves height, smoothing exit transition */}
                &nbsp;
              </Typography>
            </Collapse>

            <LoadingButton
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
            </LoadingButton>

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

        <Dialog
          open={showCreatedAccountDialog}
        >
          <DialogTitle >
            <Box display="flex" alignItems="center">
              Account Created

              <Box ml={1}>
                <SuccessIcon color="success" />
              </Box>
            </Box>
          </DialogTitle>

          <DialogContent>
            <Typography paragraph>
              Your account has been created successfully.
            </Typography>

            <StyledTextField
              fullWidth
              label="Account ID"
              value={newAccount}
              variant="standard"
            />

            <Typography paragraph>
              Please store your account ID and password in a secure location.
              If you lose your account ID or password, your data will be lost permanently.
            </Typography>

            <FormGroup>
              <FormControlLabel
                control={
                  <Checkbox
                    checked={agreement}
                    onChange={handleChangeAgreement}
                  />
                }
                label="I will stored my account ID and password in a secure location"
                required
              />
            </FormGroup>
          </DialogContent>

          <DialogActions>
            <Button
              color="primary"
              disabled={!agreement}
              onClick={handleCloseCreatedAccountDialog}
              fullWidth
              variant="contained"
            >
              Continue
            </Button>
          </DialogActions>
        </Dialog>
      </MainContainer>
    </Root>
  )
}

export default CreateAccountPage

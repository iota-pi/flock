import { type ChangeEvent, type FormEvent, useState } from 'react'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Checkbox from '@mui/material/Checkbox'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import FormControlLabel from '@mui/material/FormControlLabel'
import FormGroup from '@mui/material/FormGroup'
import IconButton from '@mui/material/IconButton'
import InputAdornment from '@mui/material/InputAdornment'
import { styled } from '@mui/material/styles'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { formatAccountId } from '@vault/shared'

import { CopyIcon, SaveIcon, SuccessIcon } from '../Icons'


const StyledTextField = styled(TextField)(({ theme }) => ({
  marginBottom: theme.spacing(1),
}))

type PasswordCredentialConstructor = new (data: { id: string, password: string }) => Credential

/**
 * Asks the browser to save the account ID and password together, where it supports that (Chromium).
 * Other browsers and password managers pick them up from the dialog's form being submitted.
 */
function offerToSaveCredential(id: string, password: string): void {
  const PasswordCredential = (window as { PasswordCredential?: PasswordCredentialConstructor }).PasswordCredential
  if (!PasswordCredential || !navigator.credentials?.store) {
    return
  }
  try {
    navigator.credentials.store(new PasswordCredential({ id, password })).catch(() => undefined)
  } catch {
    // Saving is only a convenience, and the dialog tells the user to save the ID themselves
  }
}

interface Props {
  accountId: string
  password: string
  open: boolean
  onContinue: () => void
}

export default function AccountCreatedDialog({ accountId, password, open, onContinue }: Props) {
  const [agreement, setAgreement] = useState(false)
  const [copied, setCopied] = useState(false)
  const displayedId = formatAccountId(accountId)

  function handleChangeAgreement(event: ChangeEvent<HTMLInputElement>): void {
    setAgreement(event.target.checked)
  }

  function handleClickCopy(): void {
    navigator.clipboard.writeText(displayedId).then(
      () => setCopied(true),
      () => undefined,
    )
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (!agreement) {
      return
    }
    offerToSaveCredential(displayedId, password)
    onContinue()
  }

  return (
    <Dialog open={open}>
      {/* A form with the ID as its username, so password managers save the two together on submit */}
      <form onSubmit={handleSubmit}>
        <DialogTitle>
          <Box
            sx={{
              display: "flex",
              alignItems: "center"
            }}>
            Account Created
            <Box sx={{
              ml: 1
            }}>
              <SuccessIcon color="success" />
            </Box>
          </Box>
        </DialogTitle>
        <DialogContent>
          <Typography>
            Your account has been created successfully.
          </Typography>

          <StyledTextField
            autoComplete="username"
            fullWidth
            id="new-account-id"
            label="Account ID"
            name="username"
            value={displayedId}
            variant="standard"
            slotProps={{
              htmlInput: {
                sx: { fontFamily: 'monospace', fontSize: '1.25rem' },
              },
              input: {
                readOnly: true,
                endAdornment: (
                  <InputAdornment position="end">
                    <IconButton
                      aria-label={copied ? 'Account ID copied' : 'Copy account ID'}
                      onClick={handleClickCopy}
                    >
                      {copied ? <SaveIcon /> : <CopyIcon />}
                    </IconButton>
                  </InputAdornment>
                ),
              },
            }}
          />
          <input
            aria-hidden
            autoComplete="new-password"
            name="password"
            readOnly
            style={{ display: 'none' }}
            tabIndex={-1}
            type="password"
            value={password}
          />

          <Typography>
            This is your username. When you continue, your password manager should offer to save
            it with your password. If it doesn&apos;t, add it to that entry yourself.
          </Typography>

          <Typography>
            If you lose your account ID or password, your data can&apos;t be recovered.
            While you&apos;re signed in, you can always export a backup from Settings.
          </Typography>

          <FormGroup>
            <FormControlLabel
              control={
                <Checkbox
                  checked={agreement}
                  slotProps={{
                    input: {
                      'data-cy': 'acknowledge-account-id',
                    },
                  }}
                  onChange={handleChangeAgreement}
                />
              }
              label="I've saved my account ID and password together"
              required
            />
          </FormGroup>
        </DialogContent>
        <DialogActions>
          <Button
            color="primary"
            disabled={!agreement}
            fullWidth
            type="submit"
            variant="contained"
            data-cy="continue-button"
          >
            Continue
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  )
}

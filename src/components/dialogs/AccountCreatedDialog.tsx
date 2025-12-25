import { ChangeEvent, useState } from 'react'
import {
  Box,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  FormGroup,
  styled,
  TextField,
  Typography,
} from '@mui/material'
import { SuccessIcon } from '../Icons'

const StyledTextField = styled(TextField)(({ theme }) => ({
  marginBottom: theme.spacing(1),
}))

interface Props {
  accountId: string
  open: boolean
  onContinue: () => void
}

export default function AccountCreatedDialog({ accountId, open, onContinue }: Props) {
  const [agreement, setAgreement] = useState(false)

  function handleChangeAgreement(event: ChangeEvent<HTMLInputElement>): void {
    setAgreement(event.target.checked)
  }

  return (
    <Dialog open={open}>
      <DialogTitle>
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
          value={accountId}
          variant="standard"
          slotProps={{
            input: {
              readOnly: true,
            }
          }}
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
                slotProps={{
                  input: {
                    'data-cy': 'acknowledge-account-id',
                  },
                }}
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
          onClick={onContinue}
          fullWidth
          variant="contained"
          data-cy="continue-button"
        >
          Continue
        </Button>
      </DialogActions>
    </Dialog>
  )
}

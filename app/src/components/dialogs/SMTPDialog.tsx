import { ChangeEvent, useCallback, useEffect, useState } from 'react';
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  InputAdornment,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { useMetadata } from '../../state/selectors';
import { EmailAddressIcon, PasswordIcon, PersonIcon, SaveIcon, ServerIcon } from '../Icons';

export interface Props {
  onClose: () => void,
  open: boolean,
}


function SMTPDialog({
  onClose,
  open,
}: Props) {
  const [emailSettings, setEmailSettings] = useMetadata('emailSettings');

  const [email, setEmail] = useState('');
  const [host, setHost] = useState('');
  const [name, setName] = useState('');
  const [pass, setPass] = useState('');
  const [user, setUser] = useState('');

  useEffect(
    () => {
      if (emailSettings) {
        if (emailSettings.email) setEmail(emailSettings.email);
        if (emailSettings.host) setHost(emailSettings.host);
        if (emailSettings.pass) setPass(emailSettings.pass);
        if (emailSettings.name) setName(emailSettings.name);
        if (emailSettings.user) setUser(emailSettings.user);
      }
    },
    [emailSettings],
  );

  const handleChangeEmail = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setEmail(event.target.value),
    [],
  );
  const handleChangeHost = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setHost(event.target.value),
    [],
  );
  const handleChangeName = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setName(event.target.value),
    [],
  );
  const handleChangeUser = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setUser(event.target.value),
    [],
  );
  const handleChangePass = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setPass(event.target.value),
    [],
  );

  const handleDone = useCallback(
    () => {
      setEmailSettings({ email, host, name, pass, user });
      onClose();
    },
    [email, host, name, onClose, pass, setEmailSettings, user],
  );

  const valid = !host || !user || !pass || !name || !email;

  return (
    <Dialog
      open={open}
      onClose={onClose}
    >
      <DialogTitle>
        Email Settings
      </DialogTitle>

      <DialogContent>
        <Typography paragraph>
          {'You can send bulk emails to people you\'ve added to Flock '}
          {'by using your own email\'s SMTP credentials.'}
        </Typography>

        <Typography paragraph>
          {'Your SMTP credentials are stored on Flock\'s server using the same client-side '}
          encryption method which protects all of your data in Flock.
        </Typography>

        <Stack spacing={2}>
          <TextField
            fullWidth
            label="SMTP Host"
            onChange={handleChangeHost}
            value={host}
            variant="outlined"
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <ServerIcon />
                </InputAdornment>
              ),
            }}
          />

          <TextField
            fullWidth
            label="SMTP Username"
            onChange={handleChangeUser}
            value={user}
            variant="outlined"
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <EmailAddressIcon />
                </InputAdornment>
              ),
            }}
          />

          <TextField
            fullWidth
            label="SMTP Password"
            onChange={handleChangePass}
            type="password"
            value={pass}
            variant="outlined"
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <PasswordIcon />
                </InputAdornment>
              ),
            }}
          />

          <Divider />

          <TextField
            fullWidth
            label="Sender Name"
            onChange={handleChangeName}
            value={name}
            variant="outlined"
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <PersonIcon />
                </InputAdornment>
              ),
            }}
          />

          <TextField
            fullWidth
            label="Sender Email"
            onChange={handleChangeEmail}
            value={email}
            variant="outlined"
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <EmailAddressIcon />
                </InputAdornment>
              ),
            }}
          />
        </Stack>
      </DialogContent>

      <DialogActions>
        <Button
          onClick={onClose}
          variant="outlined"
          fullWidth
        >
          Cancel
        </Button>

        <Button
          disabled={valid}
          fullWidth
          onClick={handleDone}
          startIcon={<SaveIcon />}
          variant="contained"
        >
          Done
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default SMTPDialog;

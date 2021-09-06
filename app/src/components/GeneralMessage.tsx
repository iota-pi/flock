import { useCallback, useEffect, useState } from 'react';
import { Alert, Snackbar } from '@material-ui/core';
import { useAppDispatch, useAppSelector } from '../store';
import { setUiState } from '../state/ui';


function GeneralMessage() {
  const dispatch = useAppDispatch();
  const data = useAppSelector(state => state.ui.message);
  const { message, severity } = data || {};

  const [open, setOpen] = useState(false);
  const handleClose = useCallback(() => setOpen(false), []);
  const handleExited = useCallback(
    () => dispatch(setUiState({ message: null })),
    [dispatch],
  );

  useEffect(
    () => {
      if (message) {
        setOpen(true);
      }
    },
    [message],
  );

  return (
    <Snackbar
      open={open}
      autoHideDuration={6000}
      onClose={handleClose}
      TransitionProps={{
        onExited: handleExited,
      }}
    >
      <Alert severity={severity} onClose={handleClose}>
        {message}
      </Alert>
    </Snackbar>
  );
}

export default GeneralMessage;

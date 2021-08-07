import React, { useCallback, useEffect, useState } from 'react';
import { Snackbar } from '@material-ui/core';
import { Alert } from '@material-ui/lab';
import { useAppDispatch, useAppSelector } from '../store';
import { setUiState } from '../state/ui';


function GeneralAlert() {
  const dispatch = useAppDispatch();
  const message = useAppSelector(state => state.ui.requests.error);

  const [open, setOpen] = useState(false);
  const handleClose = useCallback(() => setOpen(false), []);
  const handleExited = useCallback(
    () => dispatch(setUiState({ requests: { error: '' } })),
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
      <Alert severity="error" onClose={handleClose}>
        {message}
      </Alert>
    </Snackbar>
  );
}

export default GeneralAlert;

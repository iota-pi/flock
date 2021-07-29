import React, {
  PropsWithChildren,
} from 'react';
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
} from '@material-ui/core';

export interface Props {
  cancel?: string,
  confirm?: string,
  onCancel: () => void,
  onConfirm: () => void,
  open: boolean,
  title?: string,
}


function ConfirmationDialog({
  cancel = 'Cancel',
  children,
  confirm = 'Confirm',
  onCancel,
  onConfirm,
  open,
  title,
}: PropsWithChildren<Props>) {
  return (
    <Dialog
      open={open}
      onClose={onCancel}
    >
      <DialogTitle>
        {title}
      </DialogTitle>

      <DialogContent>
        {children}
      </DialogContent>

      <DialogActions>
        <Button
          onClick={onCancel}
          variant="outlined"
          fullWidth
        >
          {cancel}
        </Button>

        <Button
          onClick={onConfirm}
          variant="outlined"
          color="primary"
          fullWidth
        >
          {confirm}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default ConfirmationDialog;

import React, {
  PropsWithChildren, useCallback,
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
  const handleClickCancel = useCallback(() => onCancel(), [onCancel]);
  const handleClickConfirm = useCallback(() => onConfirm(), [onConfirm]);

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
          onClick={handleClickCancel}
          variant="outlined"
          fullWidth
        >
          {cancel}
        </Button>

        <Button
          onClick={handleClickConfirm}
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

import { PropsWithChildren } from 'react';
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
          data-cy="confirm-cancel"
          fullWidth
          onClick={onCancel}
          variant="outlined"
        >
          {cancel}
        </Button>

        <Button
          color="primary"
          data-cy="confirm-confirm"
          fullWidth
          onClick={onConfirm}
          variant="outlined"
        >
          {confirm}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default ConfirmationDialog;

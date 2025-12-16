import { PropsWithChildren } from 'react'
import {
  Button,
  ButtonProps,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
} from '@mui/material'

export interface Props {
  cancel?: string,
  confirm?: string,
  confirmColour?: ButtonProps['color'],
  onCancel: () => void,
  onConfirm: () => void,
  open: boolean,
  title?: string,
}


function ConfirmationDialog({
  cancel = 'Cancel',
  children,
  confirm = 'Confirm',
  confirmColour,
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
          color={confirmColour ?? 'primary'}
          data-cy="confirm-confirm"
          fullWidth
          onClick={onConfirm}
          variant="contained"
        >
          {confirm}
        </Button>
      </DialogActions>
    </Dialog>
  )
}

export default ConfirmationDialog

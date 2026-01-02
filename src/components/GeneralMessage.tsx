import { useCallback, useState } from 'react'
import { Alert, Snackbar } from '@mui/material'
import { useAppDispatch, useAppSelector } from '../store'
import { setUi } from '../state/ui'


function GeneralMessage() {
  const dispatch = useAppDispatch()
  const data = useAppSelector(state => state.ui.message)
  const { message, severity } = data || {}

  const [open, setOpen] = useState(false)
  const handleClose = useCallback(() => setOpen(false), [])
  const handleExited = useCallback(
    () => dispatch(setUi({ message: null })),
    [dispatch],
  )

  // Derived state to open snackbar when message changes
  const [prevMessage, setPrevMessage] = useState(message)
  if (message !== prevMessage) {
    setPrevMessage(message)
    if (message) {
      setOpen(true)
    }
  }

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
  )
}

export default GeneralMessage

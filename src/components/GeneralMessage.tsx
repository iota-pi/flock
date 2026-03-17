import { useCallback, useState } from 'react'
import { Alert, Snackbar } from '@mui/material'
import { useUiStore } from '../state/uiStore'


function GeneralMessage() {
  const setUi = useUiStore(state => state.setUi)
  const data = useUiStore(state => state.message)
  const { message, severity } = data || {}

  const [open, setOpen] = useState(false)
  const handleClose = useCallback(() => setOpen(false), [])
  const handleExited = useCallback(
    () => setUi({ message: null }),
    [setUi],
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

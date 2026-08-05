import { useCallback, useState } from 'react'
import Alert from '@mui/material/Alert'
import Snackbar from '@mui/material/Snackbar'

import { useAppStore } from '../state/store'


function GeneralMessage() {
  const clearMessage = useAppStore(state => state.clearMessage)
  const data = useAppStore(state => state.message)
  const { message, severity } = data || {}

  const [open, setOpen] = useState(false)
  const handleClose = useCallback(() => setOpen(false), [])
  const handleExited = useCallback(
    () => clearMessage(),
    [clearMessage],
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
      slotProps={{
        transition: {
          onExited: handleExited,
        },
      }}
    >
      <Alert severity={severity} onClose={handleClose}>
        {message}
      </Alert>
    </Snackbar>
  )
}

export default GeneralMessage

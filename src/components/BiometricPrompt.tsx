import { useCallback, useEffect, useState } from 'react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Snackbar from '@mui/material/Snackbar'

import { enableBiometrics, hasBiometricData, isWebAuthnPrfSupported } from '../api/vault'
import { useLoggedIn } from '../state/selectors'
import { useAppStore } from '../state/store'

const PROMPT_DISMISSED_KEY = 'flock_biometric_prompt_dismissed'

export default function BiometricPrompt() {
  const loggedIn = useLoggedIn()
  const account = useAppStore(state => state.account)
  const setMessage = useAppStore(state => state.setMessage)

  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!loggedIn || !account) {
      setOpen(false)
      return
    }

    let isMounted = true

    async function checkEligibility() {
      const dismissed = localStorage.getItem(PROMPT_DISMISSED_KEY) === 'true'
      if (dismissed || hasBiometricData()) {
        return
      }

      const supported = await isWebAuthnPrfSupported()
      if (isMounted && supported) {
        setOpen(true)
      }
    }

    checkEligibility()

    return () => {
      isMounted = false
    }
  }, [loggedIn, account])

  const handleDismiss = useCallback(() => {
    localStorage.setItem(PROMPT_DISMISSED_KEY, 'true')
    setOpen(false)
  }, [])

  const handleEnable = useCallback(async () => {
    if (!account) return
    setLoading(true)
    try {
      await enableBiometrics(account)
      localStorage.setItem(PROMPT_DISMISSED_KEY, 'true')
      setOpen(false)
      setMessage({
        severity: 'success',
        message: 'Biometric unlock enabled successfully!',
      })
    } catch (err) {
      console.error('Failed to enable biometrics from prompt:', err)
      setMessage({
        severity: 'error',
        message: 'Failed to enable biometric unlock.',
      })
    } finally {
      setLoading(false)
    }
  }, [account, setMessage])

  if (!open) return null

  return (
    <Snackbar
      open={open}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      onClose={handleDismiss}
    >
      <Alert
        severity="info"
        onClose={handleDismiss}
        action={(
          <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
            <Button color="inherit" size="small" disabled={loading} onClick={handleEnable}>
              Enable
            </Button>
            <Button color="inherit" size="small" disabled={loading} onClick={handleDismiss}>
              No thanks
            </Button>
          </Box>
        )}
      >
        Speed up login by enabling biometric unlock?
      </Alert>
    </Snackbar>
  )
}

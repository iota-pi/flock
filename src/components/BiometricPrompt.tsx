import { useCallback, useEffect, useState } from 'react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Snackbar from '@mui/material/Snackbar'

import { enableBiometrics, getBiometricLabel, hasBiometricData, isWebAuthnPrfSupported } from '../api/vault'
import { useAppStore } from '../state/store'

const PROMPT_DISMISSED_KEY = 'flock_biometric_prompt_dismissed'

export default function BiometricPrompt() {
  const account = useAppStore(state => state.account)
  const setMessage = useAppStore(state => state.setMessage)

  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const biometricLabel = getBiometricLabel()

  useEffect(() => {
    let isMounted = true

    async function checkEligibility() {
      if (!account) return

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
  }, [account])

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
        message: `${biometricLabel} unlock enabled successfully!`,
      })
    } catch (err) {
      console.error('Failed to enable biometrics from prompt:', err)
      setMessage({
        severity: 'error',
        message: `Failed to enable ${biometricLabel} unlock.`,
      })
    } finally {
      setLoading(false)
    }
  }, [account, biometricLabel, setMessage])

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
        Speed up future logins by enabling {biometricLabel} unlock?
      </Alert>
    </Snackbar>
  )
}

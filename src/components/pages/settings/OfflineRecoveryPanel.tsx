import { Button, CircularProgress, Paper, Stack, Typography } from '@mui/material'
import PageContainer from '../../PageContainer'
import { useOfflineRecovery } from '../../../hooks/useOfflineRecovery'

export default function OfflineRecoveryPanel() {
  const {
    deadLetterItems,
    isRetrying,
    handleRetryDeadLetterMutation,
    handleDiscardDeadLetterMutation,
  } = useOfflineRecovery()

  if (deadLetterItems.length === 0) {
    return null
  }

  return (
    <PageContainer maxWidth="xl">
      <Stack spacing={2} py={2}>
        <Typography variant="h5" fontWeight={400}>
          Offline Data Recovery
        </Typography>

        {deadLetterItems.map(item => (
          <Paper key={item.id} variant="outlined" sx={{ p: 2 }}>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems={{ sm: 'center' }}>
              <Stack flexGrow={1} spacing={0.5}>
                <Typography variant="subtitle1" fontWeight={500}>
                  {item.mutationType}
                </Typography>
                <Typography variant="body2" color="textSecondary">
                  Last error status: {item.lastErrorStatus ?? 'Unknown'}
                </Typography>
                <Typography variant="caption" color="textSecondary">
                  Last conflict at: {item.lastConflictAt ? new Date(item.lastConflictAt).toLocaleString() : 'N/A'}
                </Typography>
              </Stack>

              <Stack direction="row" spacing={1}>
                <Button
                  variant="contained"
                  size="small"
                  disabled={isRetrying !== null}
                  startIcon={isRetrying === item.id ? <CircularProgress size={14} color="inherit" /> : undefined}
                  onClick={() => {
                    void handleRetryDeadLetterMutation(item.id)
                  }}
                >
                  Retry
                </Button>
                <Button
                  variant="outlined"
                  color="warning"
                  size="small"
                  disabled={isRetrying !== null}
                  onClick={() => {
                    void handleDiscardDeadLetterMutation(item.id)
                  }}
                >
                  Discard
                </Button>
              </Stack>
            </Stack>
          </Paper>
        ))}
      </Stack>
    </PageContainer>
  )
}

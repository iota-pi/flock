import {
  Alert,
  Box,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  Tooltip,
  Typography,
} from '@mui/material'
import { DropzoneArea } from 'mui-file-dropzone'
import { useCallback, useMemo, useState } from 'react'
import { UploadIcon } from '../Icons'
import InlineText from '../ui/InlineText'
import { importData, type CryptoResult } from '../../api/vault'
import {
  type BackupPayloadV2,
  type RestorePayload,
} from '../../types/backup'

function isBackupPayloadV2(payload: unknown): payload is BackupPayloadV2 {
  if (!payload || typeof payload !== 'object') {
    return false
  }

  const candidate = payload as Partial<BackupPayloadV2>
  if (candidate.version !== 2) {
    return false
  }

  if (!candidate.documents || typeof candidate.documents !== 'object' || Array.isArray(candidate.documents)) {
    return false
  }

  return true
}

function isEncryptedBackupPayload(payload: unknown): payload is CryptoResult {
  if (!payload || typeof payload !== 'object') {
    return false
  }

  const candidate = payload as Partial<CryptoResult>
  return typeof candidate.iv === 'string' && typeof candidate.cipher === 'string'
}

function sanitizeDocuments(input: BackupPayloadV2['documents']): BackupPayloadV2['documents'] {
  const entries = Object.entries(input || {})
    .filter(([itemId, binary]) => itemId.length > 0 && typeof binary === 'string' && binary.length > 0)

  return Object.fromEntries(entries)
}

function normalizeBackupPayload(payload: BackupPayloadV2): RestorePayload {
  return {
    version: 2,
    metadata: payload.metadata,
    documents: sanitizeDocuments(payload.documents),
  }
}

const EMPTY_RESTORE_PAYLOAD: RestorePayload = {
  version: 2,
  documents: {},
}

interface Props {
  onClose: () => void,
  onConfirm: (payload: RestorePayload) => Promise<void> | void,
  open: boolean,
}

function RestoreBackupDialog({
  onClose,
  onConfirm,
  open,
}: Props) {
  const [errorMessage, setErrorMessage] = useState('')
  const [loading, setLoading] = useState(false)
  const [hasSettingsMetadata, setHasSettingsMetadata] = useState(false)
  const [restoreSettings, setRestoreSettings] = useState(false)
  const [restoredPayload, setRestoredPayload] = useState<RestorePayload>(EMPTY_RESTORE_PAYLOAD)

  const binaryDocumentCount = useMemo(
    () => Object.keys(restoredPayload.documents || {}).length,
    [restoredPayload.documents],
  )

  const backupLoadMessage = useMemo(
    () => {
      if (binaryDocumentCount > 0) {
        return `Loaded ${binaryDocumentCount} CRDT documents`
      }

      return 'Upload a Flock backup file'
    },
    [binaryDocumentCount],
  )

  const resetDialogState = useCallback(() => {
    setErrorMessage('')
    setHasSettingsMetadata(false)
    setRestoreSettings(false)
    setRestoredPayload(EMPTY_RESTORE_PAYLOAD)
  }, [])

  const handleChange = useCallback(
    async (files: File[]) => {
      if (files.length === 0) {
        resetDialogState()
        return
      }

      const file = files[0]
      let encryptedPayload: unknown

      try {
        encryptedPayload = JSON.parse(await file.text())
      } catch {
        setErrorMessage('Invalid backup file format')
        setRestoredPayload(EMPTY_RESTORE_PAYLOAD)
        setHasSettingsMetadata(false)
        setRestoreSettings(false)
        return
      }

      if (!isEncryptedBackupPayload(encryptedPayload)) {
        setErrorMessage('Invalid backup file format')
        setRestoredPayload(EMPTY_RESTORE_PAYLOAD)
        setHasSettingsMetadata(false)
        setRestoreSettings(false)
        return
      }

      const imported = await importData<unknown>(encryptedPayload).catch(() => {
        setErrorMessage('Could not decrypt file successfully')
        return null
      })

      if (!imported) {
        setRestoredPayload(EMPTY_RESTORE_PAYLOAD)
        setHasSettingsMetadata(false)
        setRestoreSettings(false)
        return
      }

      if (!isBackupPayloadV2(imported)) {
        setErrorMessage('Deprecated backup format. Please restore from a CRDT binary backup (v2+).')
        setRestoredPayload(EMPTY_RESTORE_PAYLOAD)
        setHasSettingsMetadata(false)
        setRestoreSettings(false)
        return
      }

      setErrorMessage('')
      setHasSettingsMetadata(Object.prototype.hasOwnProperty.call(imported, 'metadata'))
      setRestoredPayload(normalizeBackupPayload(imported))
    },
    [resetDialogState],
  )

  const handleConfirmRestore = useCallback(
    async () => {
      setLoading(true)
      try {
        await onConfirm({
          version: 2,
          metadata: restoreSettings ? restoredPayload.metadata : undefined,
          documents: restoredPayload.documents,
        })
      } finally {
        setLoading(false)
      }
    },
    [onConfirm, restoreSettings, restoredPayload.documents, restoredPayload.metadata],
  )

  return (
    <Dialog
      onClose={onClose}
      open={open}
      fullWidth
      maxWidth="sm"
    >
      <DialogTitle>
        Restore from backup
      </DialogTitle>

      <DialogContent>
        <DropzoneArea
          acceptedFiles={['.json']}
          dropzoneText="Upload a backup file here"
          filesLimit={1}
          showAlerts={['error']}
          showPreviewsInDropzone={false}
          maxFileSize={10000000}
          onChange={handleChange}
        />

        <Box my={2}>
          {errorMessage && (
            <Alert severity={'error'}>
              {errorMessage}
            </Alert>
          )}

          {!errorMessage && (
            <Alert
              severity={binaryDocumentCount > 0 ? 'success' : 'info'}
            >
              {backupLoadMessage}
            </Alert>
          )}
        </Box>

        <Box mt={2}>
          <Tooltip
            title={hasSettingsMetadata ? '' : 'This backup file does not contain settings.'}
            disableHoverListener={hasSettingsMetadata}
          >
            <span>
              <FormControlLabel
                control={(
                  <Checkbox
                    checked={restoreSettings && hasSettingsMetadata}
                    onChange={(_event, checked) => setRestoreSettings(checked)}
                    disabled={!hasSettingsMetadata || loading}
                  />
                )}
                label="Restore settings"
              />
            </span>
          </Tooltip>
        </Box>

        <Typography>
          <InlineText fontWeight={500}>Important!</InlineText>
          {' '}
          Restoring a backup will restore full CRDT histories from the backup file.
          It will not remove any items created after the backup.
          Restores are permanent and cannot be undone.
          We strongly recommend creating another backup before continuing.
        </Typography>
      </DialogContent>

      <DialogActions>
        <Button
          data-cy="import-cancel"
          fullWidth
          onClick={onClose}
          variant="outlined"
          disabled={loading}
        >
          Cancel
        </Button>

        <Button
          color="error"
          data-cy="import-confirm"
          disabled={loading || binaryDocumentCount === 0}
          fullWidth
          onClick={handleConfirmRestore}
          loading={loading}
          loadingPosition="start"
          startIcon={<UploadIcon />}
          variant="outlined"
        >
          Restore
        </Button>
      </DialogActions>
    </Dialog>
  )
}

export default RestoreBackupDialog

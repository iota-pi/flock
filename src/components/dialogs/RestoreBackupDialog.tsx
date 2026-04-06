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
import { Item } from '../../state/items'
import { UploadIcon } from '../Icons'
import InlineText from '../ui/InlineText'
import { importData } from '../../api/vault'
import { useItems } from '../../state/selectors'
import { hasItemDiff } from '../../features/items/utils/itemDiff'
import SelectImportItemsDialog from './SelectImportItemsDialog'
import {
  type BackupPayloadV1,
  type DecryptedBackupPayload,
  type RestorePayload,
} from '../../types/backup'
import { mergeObjectsInWorker } from '../../workers/decryptionWorkerManager'

function normalizeDecryptedBackup(payload: DecryptedBackupPayload): RestorePayload {
  if (Array.isArray(payload)) {
    return {
      items: payload,
      offlineQueue: [],
      deadLetterQueue: [],
    }
  }

  const data = payload as BackupPayloadV1
  return {
    metadata: data.metadata,
    items: data.items || [],
    offlineQueue: data.offlineQueue || [],
    deadLetterQueue: data.deadLetterQueue || [],
  }
}

export interface Props {
  onClose: () => void,
  onConfirm: (payload: RestorePayload) => Promise<void> | void,
  open: boolean,
}

function getChangedItems(importedItems: Item[], existingItems: Item[]): Item[] {
  const existingMap = new Map(existingItems.map(item => [item.id, item]))
  return importedItems.filter(item => {
    const existing = existingMap.get(item.id)
    if (!existing) return true
    return hasItemDiff(existing, item)
  })
}

async function mergeWithAutomergeInWorker<T extends object>(left: T, right: T): Promise<T> {
  if (typeof Worker === 'undefined') {
    return right
  }

  return mergeObjectsInWorker({
    left: left as Record<string, unknown>,
    right: right as Record<string, unknown>,
  }) as Promise<T>
}

function RestoreBackupDialog({
  onClose,
  onConfirm,
  open,
}: Props) {
  const existingItems = useItems()
  const [importedItems, setImportedItems] = useState<Item[]>([])
  const [errorMessage, setErrorMessage] = useState('')
  const [loading, setLoading] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [isSelectionOpen, setIsSelectionOpen] = useState(false)
  const [hasSettingsMetadata, setHasSettingsMetadata] = useState(false)
  const [restoreSettings, setRestoreSettings] = useState(false)
  const [restoredPayload, setRestoredPayload] = useState<RestorePayload>({
    items: [],
    offlineQueue: [],
    deadLetterQueue: [],
  })

  const changedItems = useMemo(
    () => getChangedItems(importedItems, existingItems),
    [existingItems, importedItems],
  )

  const { modifiedCount, addedCount } = useMemo(
    () => {
      if (!importedItems.length) {
        return { modifiedCount: 0, addedCount: 0 }
      }
      const existingMap = new Map(existingItems.map(item => [item.id, item]))

      let modified = 0
      let added = 0

      for (const item of changedItems) {
        if (!selectedIds.has(item.id)) continue
        if (existingMap.has(item.id)) {
          modified += 1
        } else {
          added += 1
        }
      }

      return { modifiedCount: modified, addedCount: added }
    },
    [existingItems, importedItems, selectedIds, changedItems],
  )

  const handleChange = useCallback(
    async (files: File[]) => {
      if (files.length > 0) {
        const file = files[0]
        const text = await file.text()
        const data = JSON.parse(text)
        setErrorMessage('')
        const imported = await importData<DecryptedBackupPayload>(data).catch(() => {
          setErrorMessage('Could not decrypt file successfully')
          return [] as DecryptedBackupPayload
        })

        const metadataPresent = !Array.isArray(imported)
          && Object.prototype.hasOwnProperty.call(imported, 'metadata')
        setHasSettingsMetadata(metadataPresent)

        const normalized = normalizeDecryptedBackup(imported)
        let items = normalized.items
        setRestoredPayload(normalized)

        // Run migrations on restored items to ensure they match current schema
        if (items.length > 0) {
          const { runAllMigrationsInMemory } = await import('../../state/migrations/utils')
          items = await runAllMigrationsInMemory(items)
        }

        const changed = getChangedItems(items, existingItems)
        setImportedItems(items)
        setSelectedIds(new Set(changed.map(i => i.id)))
      } else {
        setImportedItems([])
        setSelectedIds(new Set())
        setHasSettingsMetadata(false)
        setRestoreSettings(false)
        setRestoredPayload({
          items: [],
          offlineQueue: [],
          deadLetterQueue: [],
        })
      }
    },
    [existingItems],
  )

  const handleConfirmImport = useCallback(
    async () => {
      setLoading(true)
      try {
        const existingMap = new Map(existingItems.map(item => [item.id, item]))
        const selectedItems = importedItems.filter(item => selectedIds.has(item.id))
        const itemsToImport = await Promise.all(selectedItems.map(async item => {
          const existing = existingMap.get(item.id)
          if (!existing) return item
          return mergeWithAutomergeInWorker(existing, item)
        }))

        await onConfirm({
          metadata: restoreSettings ? restoredPayload.metadata : undefined,
          items: itemsToImport,
          offlineQueue: restoredPayload.offlineQueue,
          deadLetterQueue: restoredPayload.deadLetterQueue,
        })
      } finally {
        setLoading(false)
      }
    },
    [existingItems, importedItems, onConfirm, restoreSettings, restoredPayload.deadLetterQueue, restoredPayload.metadata, restoredPayload.offlineQueue, selectedIds],
  )

  return (
    <>
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
            fileObjects={null}
            filesLimit={1}
            showAlerts={['error']}
            showPreviewsInDropzone={false}
            maxFileSize={10000000}
            onChange={handleChange}
          />

          <Box my={2}>
            {errorMessage && (
              <Alert severity={"error"}>
                {errorMessage}
              </Alert>
            )}

            {!errorMessage && (
              <Alert
                severity={importedItems.length > 0 ? 'success' : 'info'}
              >
                {(importedItems.length > 0
                  ? (
                    `Loaded ${importedItems.length} items (`
                    + `${importedItems.length - changedItems.length} unchanged`
                    + `, ${changedItems.length} can be restored)`
                  )
                  : 'Upload a Flock backup file'
                )}

                {changedItems.length > 0 && (
                  <Box mt={1}>
                    <Button
                      variant="contained"
                      fullWidth
                      onClick={() => setIsSelectionOpen(true)}
                    >
                      {`${selectedIds.size}/${changedItems.length} selected`}
                    </Button>
                  </Box>
                )}
              </Alert>
            )}
          </Box>

          {changedItems.length > 0 && (
            <Box mt={2}>
              <Alert severity="info">
                {`${modifiedCount} ${modifiedCount !== 1 ? 'items' : 'item'} will be updated`}
                <br />
                {`${addedCount} ${addedCount !== 1 ? 'items' : 'item'} will be added`}
              </Alert>
            </Box>
          )}

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
            Importing a backup will undo changes you have made to items since the backup.
            It will not remove any items you have created since the backup.
            Imports are permanent and cannot be undone.
            We strongly recommend creating another backup before continuing with the import.
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
            disabled={selectedIds.size === 0 || loading}
            fullWidth
            onClick={handleConfirmImport}
            loading={loading}
            loadingPosition="start"
            startIcon={<UploadIcon />}
            variant="outlined"
          >
            Import
          </Button>
        </DialogActions>
      </Dialog>

      {isSelectionOpen && (
        <SelectImportItemsDialog
          open={isSelectionOpen}
          items={changedItems}
          existingItems={new Map(existingItems.map(item => [item.id, item]))}
          initialSelectedIds={selectedIds}
          onClose={() => setIsSelectionOpen(false)}
          onConfirm={newSelected => {
            setSelectedIds(newSelected)
            setIsSelectionOpen(false)
          }}
        />
      )}
    </>
  )
}

export default RestoreBackupDialog

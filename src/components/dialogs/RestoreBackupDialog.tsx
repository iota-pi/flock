import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Typography,
} from '@mui/material'
import { DropzoneArea } from 'mui-file-dropzone'
import { useCallback, useMemo, useState } from 'react'
import { Item } from '../../state/items'
import { UploadIcon } from '../Icons'
import InlineText from '../InlineText'
import { importData } from '../../api/Vault'
import { useItems } from '../../state/selectors'

export interface Props {
  onClose: () => void,
  onConfirm: (items: Item[]) => void,
  open: boolean,
}

function RestoreBackupDialog({
  onClose,
  onConfirm,
  open,
}: Props) {
  const existingPeople = useItems('person')
  const [importedItems, setImportedItems] = useState<Item[]>([])
  const [errorMessage, setErrorMessage] = useState('')

  const { overwriteCount, addedCount } = useMemo(() => {
    if (!importedItems.length) return { overwriteCount: 0, addedCount: 0 }
    const existingMap = new Map(existingPeople.map(item => [item.id, item]))

    let overwrite = 0
    let added = 0

    for (const item of importedItems) {
      if (item.type !== 'person') continue
      const existing = existingMap.get(item.id)
      if (!existing) {
        added += 1
        continue
      }
      if (JSON.stringify(existing) !== JSON.stringify(item)) {
        overwrite += 1
      }
    }

    return { overwriteCount: overwrite, addedCount: added }
  }, [existingPeople, importedItems])

  const handleChange = useCallback(
    async (files: File[]) => {
      if (files.length > 0) {
        const file = files[0]
        const text = await file.text()
        const data = JSON.parse(text)
        setErrorMessage('')
        const items = await importData(data).catch(() => {
          setErrorMessage('Could not decrypt file successfully')
          return [] as Item[]
        })
        setImportedItems(items)
      } else {
        setImportedItems([])
      }
    },
    [],
  )

  const handleConfirmImport = useCallback(
    () => {
      onConfirm(importedItems)
    },
    [importedItems, onConfirm],
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
          fileObjects={null} // Shouldn't be needed, seems to be a TS glitch
          filesLimit={1}
          showAlerts={['error']}
          showPreviewsInDropzone={false}
          maxFileSize={10000000}
          onChange={handleChange}
        />

        <Box my={2}>
          <Alert
            severity={(
              (errorMessage && 'error')
              || (importedItems.length > 0 && 'success')
              || 'info'
            )}
          >
            {errorMessage}

            {!errorMessage && (
              importedItems.length > 0
                ? `Ready to restore ${importedItems.length} items from backup`
                : 'Upload a Flock backup file'
            )}
          </Alert>

          {(!errorMessage && importedItems.length > 0) && (
            <Box mt={2}>
              <Alert severity={overwriteCount > 0 ? 'warning' : 'info'}>
                {`${overwriteCount} ${overwriteCount !== 1 ? 'people' : 'person'} will be overwritten`}
                <br />
                {`${addedCount} ${addedCount !== 1 ? 'people' : 'person'} will be added`}
              </Alert>
            </Box>
          )}
        </Box>

        <Typography paragraph>
          <InlineText fontWeight={500}>Important!</InlineText>
          {' '}
          Importing a backup will overwrite all changes to existing items you have made since creating it.
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
        >
          Cancel
        </Button>

        <Button
          color="error"
          data-cy="import-confirm"
          disabled={importedItems.length === 0}
          fullWidth
          onClick={handleConfirmImport}
          startIcon={<UploadIcon />}
          variant="outlined"
        >
          Import
        </Button>
      </DialogActions>
    </Dialog>
  )
}

export default RestoreBackupDialog

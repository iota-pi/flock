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
import { importData } from '../../api/VaultLazy'
import { useItems } from '../../state/selectors'
import { threeWayMerge } from '../../utils/merge'
import { diffItems } from 'src/utils/diff'
import SelectImportItemsDialog from './SelectImportItemsDialog'

export interface Props {
  onClose: () => void,
  onConfirm: (items: Item[]) => Promise<void> | void,
  open: boolean,
}

function getChangedItems(importedItems: Item[], existingItems: Item[]): Item[] {
  const existingMap = new Map(existingItems.map(item => [item.id, item]))
  return importedItems.filter(item => {
    const existing = existingMap.get(item.id)
    if (!existing) return true
    if (existing.version !== item.version) return true
    return diffItems(existing, item).length > 0
  })
}

function RestoreBackupDialog({
  onClose,
  onConfirm,
  open,
}: Props) {
  const existingPeople = useItems('person')
  const [importedItems, setImportedItems] = useState<Item[]>([])
  const [errorMessage, setErrorMessage] = useState('')
  const [loading, setLoading] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [isSelectionOpen, setIsSelectionOpen] = useState(false)

  const changedItems = useMemo(
    () => getChangedItems(importedItems, existingPeople),
    [existingPeople, importedItems],
  )

  const { modifiedCount, addedCount } = useMemo(
    () => {
      if (!importedItems.length) return { modifiedCount: 0, addedCount: 0 }
      const existingMap = new Map(existingPeople.map(item => [item.id, item]))

      let modified = 0
      let added = 0

      for (const item of changedItems) {
        if (!selectedIds.has(item.id)) continue
        if (item.type !== 'person') continue

        if (existingMap.has(item.id)) {
          modified += 1
        } else {
          added += 1
        }
      }

      return { modifiedCount: modified, addedCount: added }
    },
    [existingPeople, importedItems, selectedIds, changedItems],
  )

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

        const changed = getChangedItems(items, existingPeople)
        setImportedItems(items)
        setSelectedIds(new Set(changed.map(i => i.id)))
      } else {
        setImportedItems([])
        setSelectedIds(new Set())
      }
    },
    [existingPeople],
  )

  const handleConfirmImport = useCallback(
    async () => {
      setLoading(true)
      const existingMap = new Map(existingPeople.map(item => [item.id, item]))
      const itemsToImport = importedItems
        .filter(item => selectedIds.has(item.id))
        .map(item => {
          const existing = existingMap.get(item.id)
          if (!existing) return item
          const merged = threeWayMerge({} as Item, existing, item)
          merged.version = Math.max(existing.version, item.version) + 1
          return merged
        })

      await onConfirm(itemsToImport)
      setLoading(false)
    },
    [existingPeople, importedItems, onConfirm, selectedIds],
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
                  ? `Found ${changedItems.length} items to restore`
                  : 'Upload a Flock backup file'
              )}

              {!errorMessage && changedItems.length > 0 && (
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

            {(!errorMessage && changedItems.length > 0) && (
              <Box mt={2}>
                <Alert severity="info">
                  {`${modifiedCount} ${modifiedCount !== 1 ? 'people' : 'person'} will be updated`}
                  <br />
                  {`${addedCount} ${addedCount !== 1 ? 'people' : 'person'} will be added`}
                </Alert>
              </Box>
            )}
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
          existingItems={new Map(existingPeople.map(item => [item.id, item]))}
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

import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
} from '@mui/material'
import { DropzoneArea } from 'mui-file-dropzone'
import { parse } from 'csv-parse/browser/esm/sync'
import { useCallback, useMemo, useState } from 'react'
import { importPeople, Item } from '../../state/items'
import { useItems } from '../../state/selectors'
import { UploadIcon } from '../Icons'


export interface Props {
  onClose: () => void,
  onConfirm: (items: Item[]) => void,
  open: boolean,
}

function ImportPeopleDialog({
  onClose,
  onConfirm,
  open,
}: Props) {
  const existingPeople = useItems('person')
  const [importedItems, setImportedItems] = useState<Item[]>([])
  const [errorMessage, setErrorMessage] = useState('')

  const { overwriteCount, addedCount } = useMemo(
    () => {
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
    },
    [existingPeople, importedItems],
  )

  const handleChange = useCallback(
    async (files: File[]) => {
      if (files.length > 0) {
        const file = files[0]
        const text = await file.text()
        const data = parse<Record<string, string>>(text, {
          skipEmptyLines: true,
          columns: (headers: string[]) => headers.map(header => {
            const normalised = header.replace(/[ _-]/g, '').toLowerCase()
            const headersMap: Record<string, string> = {
              name: 'name',
              fullname: 'name',
              firstname: 'firstname',
              lastname: 'lastname',
              surname: 'lastname',
              description: 'description',
              summary: 'summary',
            }
            return headersMap[normalised] || null
          }),
          onRecord: record => {
            if (typeof record.name === 'string') {
              const nameParts = record.name.split(',')
              if (nameParts.length > 1) {
                return {
                  ...record,
                  name: nameParts[1] + nameParts[0],
                }
              }
            }
            return record
          },
        })
        setErrorMessage('')
        const items = importPeople(data)
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
        Import People from CSV
      </DialogTitle>

      <DialogContent>
        <DropzoneArea
          acceptedFiles={['.csv']}
          dropzoneText="Upload a CSV file here"
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
              || (importedItems.length > 1 && 'success')
              || 'info'
            )}
          >
            {errorMessage}

            {!errorMessage && (
              importedItems.length > 1
                ? `Ready to import ${importedItems.length - 1} items from CSV`
                : 'Upload a CSV file here'
            )}
          </Alert>
        </Box>

        {(!errorMessage && importedItems.length > 1) && (
          <Box mt={2}>
            <Alert severity={overwriteCount > 0 ? 'warning' : 'info'}>
              {`${overwriteCount} ${overwriteCount !== 1 ? 'people' : 'person'} will be overwritten`}
              <br />
              {`${addedCount} ${addedCount !== 1 ? 'people' : 'person'} will be added`}
            </Alert>
          </Box>
        )}
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
          disabled={importedItems.length === 1}
          fullWidth
          onClick={handleConfirmImport}
          startIcon={<UploadIcon />}
          variant="contained"
        >
          Import
        </Button>
      </DialogActions>
    </Dialog>
  )
}

export default ImportPeopleDialog

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
// eslint-disable-next-line import/no-unresolved
import { parse } from 'csv-parse/browser/esm/sync'
import { useCallback, useState } from 'react'
import { importPeople, Item } from '../../state/items'
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
  const [importedItems, setImportedItems] = useState<Item[]>([])
  const [errorMessage, setErrorMessage] = useState('')

  const handleChange = useCallback(
    async (files: File[]) => {
      if (files.length > 0) {
        const file = files[0]
        const text = await file.text()
        const data = await parse(text, {
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

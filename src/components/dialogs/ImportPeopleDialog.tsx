import { useCallback, useMemo, useState } from 'react'
import Button from '@mui/material/Button'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import { DropzoneArea } from 'mui2-file-dropzone'
import { parse } from 'csv-parse/browser/esm/sync'

import type { Item } from '../../state/items'
import { UploadIcon } from '../Icons'
import { importPeople } from 'src/utils/importUtils'


function parsePeopleCsv(text: string): Record<string, string>[] {
  return parse<Record<string, string>>(text, {
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
        summary: 'notes',
        notes: 'notes',
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
}

/** A message for a CSV parse error, which says where the problem is but not what the file contains */
function describeCsvError(error: unknown): string {
  const lines = typeof error === 'object' && error !== null && 'lines' in error ? error.lines : undefined
  const where = typeof lines === 'number' ? ` near line ${lines}` : ''
  return `This file could not be read as CSV${where}. Check its quotes and columns, then try again.`
}

interface Props {
  existingPeople: Item[],
  onClose: () => void,
  onConfirm: (items: Item[]) => void,
  open: boolean,
}

function ImportPeopleDialog({
  existingPeople,
  onClose,
  onConfirm,
  open,
}: Props) {
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
        let data: Record<string, string>[]
        try {
          data = parsePeopleCsv(text)
        } catch (error) {
          // csv-parse's messages quote the offending field, so they are shown here rather than
          // thrown, where they would reach error telemetry
          setImportedItems([])
          setErrorMessage(describeCsvError(error))
          return
        }
        setErrorMessage('')
        const items = await importPeople(data)
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
          acceptedFiles={{ 'text/csv': ['.csv'] }}
          dropzoneText="Upload a CSV file here"
          filesLimit={1}
          showAlerts={['error']}
          showPreviewsInDropzone={false}
          maxFileSize={10000000}
          onChange={handleChange}
        />

        <Box sx={{
          my: 2
        }}>
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
          <Box sx={{
            mt: 2
          }}>
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

import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
} from '@mui/material';
import makeStyles from '@mui/styles/makeStyles';
import { DropzoneArea } from 'material-ui-dropzone';
import neatCsv from 'neat-csv';
import { useCallback, useState } from 'react';
import { importPeople, PersonItem } from '../../state/items';
import { useVault } from '../../state/selectors';
import { UploadIcon } from '../Icons';

const useStyles = makeStyles(theme => ({
  root: {},
  alert: {
    marginTop: theme.spacing(2),
    marginBottom: theme.spacing(2),
  },
  emphasis: {
    fontWeight: 500,
  },
}));

export interface Props {
  onClose: () => void,
  onConfirm: (items: PersonItem[]) => void,
  open: boolean,
}

function ImportPeopleDialog({
  onClose,
  onConfirm,
  open,
}: Props) {
  const classes = useStyles();
  const vault = useVault();
  const [importedItems, setImportedItems] = useState<PersonItem[]>([]);
  const [errorMessage, setErrorMessage] = useState('');

  const handleChange = useCallback(
    async (files: File[]) => {
      if (vault && files.length > 0) {
        const file = files[0];
        const text = await file.text();
        const data = await neatCsv(text, {
          mapHeaders: ({ header }) => {
            const normalised = header.replace(/[ _-]/g, '').toLowerCase();
            const headersMap: Record<string, string> = {
              name: 'name',
              fullname: 'name',
              firstname: 'firstname',
              lastname: 'lastname',
              surname: 'lastname',
              email: 'email',
              phone: 'phone',
              description: 'description',
              summary: 'summary',
              notes: 'summary',
            };
            return headersMap[normalised] || null;
          },
          mapValues: ({ header, value }) => {
            if (header === 'name' && typeof value === 'string') {
              const nameParts = value.split(',');
              if (nameParts.length > 1) {
                return nameParts[1] + nameParts[0];
              }
            }
            return value.trim();
          },
        });
        setErrorMessage('');
        const items = importPeople(data);
        setImportedItems(items);
      } else {
        setImportedItems([]);
      }
    },
    [vault],
  );

  const handleConfirmImport = useCallback(
    () => {
      onConfirm(importedItems);
    },
    [importedItems, onConfirm],
  );

  return (
    <Dialog
      className={classes.root}
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
          filesLimit={1}
          dropzoneText="Upload a CSV file here"
          showAlerts={['error']}
          showPreviewsInDropzone={false}
          maxFileSize={10000000}
          onChange={handleChange}
        />

        <Alert
          className={classes.alert}
          severity={(
            (errorMessage && 'error')
            || (importedItems.length > 0 && 'success')
            || 'info'
          )}
        >
          {errorMessage}

          {!errorMessage && (
            importedItems.length > 0
              ? `Ready to import ${importedItems.length} items from CSV`
              : 'Upload a CSV file here'
          )}
        </Alert>
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
          disabled={importedItems.length === 0}
          fullWidth
          onClick={handleConfirmImport}
          startIcon={<UploadIcon />}
          variant="contained"
        >
          Import
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default ImportPeopleDialog;

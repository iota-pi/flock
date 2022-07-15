import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Typography,
} from '@mui/material';
import { DropzoneArea } from 'mui-file-dropzone';
import { useCallback, useState } from 'react';
import { Item } from '../../state/items';
import { useVault } from '../../state/selectors';
import { UploadIcon } from '../Icons';
import InlineText from '../InlineText';

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
  const vault = useVault();
  const [importedItems, setImportedItems] = useState<Item[]>([]);
  const [errorMessage, setErrorMessage] = useState('');

  const handleChange = useCallback(
    async (files: File[]) => {
      if (vault && files.length > 0) {
        const file = files[0];
        const text = await file.text();
        const data = JSON.parse(text);
        setErrorMessage('');
        const items = await vault.importData(data).catch(() => {
          setErrorMessage('Could not decrypt file successfully');
          return [] as Item[];
        });
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
        </Box>

        <Typography paragraph>
          <InlineText fontWeight={500}>Important!</InlineText>
          {' '}
          Importing a backup will overwrite all changes you have made since creating it.
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
  );
}

export default RestoreBackupDialog;

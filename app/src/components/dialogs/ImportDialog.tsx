import {
  alpha,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  makeStyles,
  Typography,
} from '@material-ui/core';
import { Alert } from '@material-ui/lab';
import { DropzoneArea } from 'material-ui-dropzone';
import { useCallback, useState } from 'react';
import { Item } from '../../state/items';
import { useVault } from '../../state/selectors';
import { UploadIcon } from '../Icons';

const useStyles = makeStyles(theme => ({
  root: {},
  listItemContainer: {
    position: 'relative',
  },
  maturityItem: {
    display: 'flex',
    alignItems: 'center',
    flexGrow: 1,
    paddingTop: theme.spacing(1),
    paddingBottom: theme.spacing(1),
  },
  indexNumber: {
    fontWeight: 500,
    marginRight: theme.spacing(2),
  },
  orderControls: {
    display: 'flex',
    flexDirection: 'column',
    marginRight: theme.spacing(2),
  },
  addButton: {
    marginTop: theme.spacing(2),
  },
  alert: {
    marginTop: theme.spacing(2),
    marginBottom: theme.spacing(2),
  },
  emphasis: {
    fontWeight: 500,
  },
  danger: {
    color: alpha(theme.palette.error.main, 0.92),
    borderColor: alpha(theme.palette.error.main, 0.7),
    '&:hover': {
      backgroundColor: alpha(theme.palette.error.main, 0.08),
    },
  },
}));

export interface Props {
  onClose: () => void,
  onConfirm: (items: Item[]) => void,
  open: boolean,
}

function ImportDialog({
  onClose,
  onConfirm,
  open,
}: Props) {
  const classes = useStyles();
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
      className={classes.root}
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
          filesLimit={1}
          dropzoneText="Upload a backup file here"
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
              ? `Ready to restore ${importedItems.length} items from backup`
              : 'Upload a Flock backup file'
          )}
        </Alert>

        <Typography paragraph>
          <span className={classes.emphasis}>Important!</span>
          {' '}
          Importing this backup will overwrite all changes you have made since creating it.
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
          className={classes.danger}
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

export default ImportDialog;

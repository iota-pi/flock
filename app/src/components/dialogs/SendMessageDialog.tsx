import {
  useCallback,
  useState,
} from 'react';
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
} from '@mui/material';
import makeStyles from '@mui/styles/makeStyles';
import {
  PersonItem,
} from '../../state/items';
import { useVault } from '../../state/selectors';
import { DeleteIcon, EmailIcon } from '../Icons';
import { getRecipientFields, MessageFull } from '../../state/koinonia';
import ItemList from '../ItemList';
import smtp from '../../utils/smtp';
import Search from '../Search';

export const useStyles = makeStyles(() => ({
  root: {},
  list: {
    paddingBottom: 0,
  },
}));

export interface Props {
  message: MessageFull,
  onClose: () => void,
  open: boolean,
}


function SendMessageDialog({
  message,
  onClose,
  open,
}: Props) {
  const classes = useStyles();
  const vault = useVault();

  const [recipients, setRecipients] = useState<PersonItem[]>([]);

  const handleClearRecipients = useCallback(() => setRecipients([]), []);
  const handleAddRecipient = useCallback(
    (recipient: PersonItem) => setRecipients(
      oldRecipients => [...oldRecipients, recipient],
    ),
    [],
  );
  const handleRemoveRecipient = useCallback(
    (recipient: PersonItem) => setRecipients(
      oldRecipients => oldRecipients.filter(r => r.id !== recipient.id),
    ),
    [],
  );

  const handleSend = useCallback(
    () => {
      vault?.koinonia.sendMessage({
        message: message.message,
        details: {
          content: message.data.html || '',
          recipients: getRecipientFields(recipients),
          subject: message.name,
          from: smtp.from,
          smtp: smtp.smtp,
        },
      });
      onClose();
    },
    [message, onClose, recipients, vault],
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
        Send {message.name}
      </DialogTitle>

      <DialogContent>
        <Stack spacing={2} paddingTop={2}>
          <Search<PersonItem>
            autoFocus
            label="Select message recipients"
            noItemsText="No people found"
            onClear={handleClearRecipients}
            onRemove={handleRemoveRecipient}
            onSelect={handleAddRecipient}
            selectedItems={recipients}
            types={{ person: true, group: true, general: true }}
          />

          <ItemList
            className={classes.list}
            dividers
            getActionIcon={() => <DeleteIcon />}
            items={recipients}
            noItemsHint="No recipients selected"
            onClickAction={handleRemoveRecipient}
            showIcons
          />
        </Stack>
      </DialogContent>

      <DialogActions>
        <Button
          disabled={recipients.length === 0}
          fullWidth
          onClick={onClose}
          variant="outlined"
        >
          Cancel
        </Button>

        <Button
          disabled={recipients.length === 0}
          fullWidth
          onClick={handleSend}
          startIcon={<EmailIcon />}
          variant="contained"
        >
          Send
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default SendMessageDialog;

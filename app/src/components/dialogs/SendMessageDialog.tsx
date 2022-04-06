import {
  useCallback,
  useMemo,
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
import { useItems, useMaturity, useSortCriteria, useVault } from '../../state/selectors';
import { DeleteIcon, EmailIcon } from '../Icons';
import { getRecipientFields, MessageFull } from '../../state/koinonia';
import ItemSearch from '../ItemSearch';
import ItemList from '../ItemList';
import { sortItems } from '../../utils/customSort';
import smtp from '../../utils/smtp';

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
  const people = useItems<PersonItem>('person');
  const [sortCriteria] = useSortCriteria();
  const [maturity] = useMaturity();
  const vault = useVault();

  const activePeople = useMemo(
    () => sortItems(people.filter(p => !p.archived), sortCriteria, maturity),
    [maturity, people, sortCriteria],
  );

  const [recipients, setRecipients] = useState<PersonItem[]>([]);
  const recipientIds = useMemo(
    () => recipients.map(r => r.id),
    [recipients],
  );

  const handleAddRecipients = useCallback(
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
          <ItemSearch
            items={activePeople}
            label="Add group members"
            noItemsText="No people found"
            onSelect={handleAddRecipients}
            selectedIds={recipientIds}
            showSelected={false}
          />

          <ItemList
            className={classes.list}
            dividers
            getActionIcon={() => <DeleteIcon />}
            items={recipients}
            noItemsHint="No recipients selected"
            onClickAction={handleRemoveRecipient}
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

import {
  useCallback,
  useMemo,
  useState,
} from 'react';
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
} from '@mui/material';
import makeStyles from '@mui/styles/makeStyles';
import {
  GroupItem,
  PersonItem,
} from '../../state/items';
import { useItems, useItemsById, useMetadata, useVault } from '../../state/selectors';
import { MessageIcon } from '../Icons';
import { getRecipientFields, MessageFull } from '../../state/koinonia';
import Search, { getSearchableDataId } from '../Search';
import { useAppDispatch } from '../../store';
import { setMessage } from '../../state/ui';

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

type RecipientTypes = PersonItem | GroupItem | string;

function SendMessageDialog({
  message,
  onClose,
  open,
}: Props) {
  const classes = useStyles();
  const dispatch = useAppDispatch();
  const people = useItems<PersonItem>('person');
  const getItemsById = useItemsById();
  const [emailSettings] = useMetadata('emailSettings');
  const vault = useVault();

  const [recipients, setRecipients] = useState<RecipientTypes[]>([]);

  const handleClearRecipients = useCallback(() => setRecipients([]), []);
  const handleAddRecipient = useCallback(
    (recipient: RecipientTypes) => setRecipients(
      oldRecipients => [...oldRecipients, recipient],
    ),
    [],
  );
  const handleRemoveRecipient = useCallback(
    (recipient: RecipientTypes) => setRecipients(
      oldRecipients => oldRecipients.filter(
        r => getSearchableDataId(r) !== getSearchableDataId(recipient),
      ),
    ),
    [],
  );

  const recipientIndividuals = useMemo(
    () => recipients.filter((r): r is PersonItem => typeof r !== 'string' && r.type === 'person'),
    [recipients],
  );
  const recipientGroups = useMemo(
    () => recipients.filter((r): r is GroupItem => typeof r !== 'string' && r.type === 'group'),
    [recipients],
  );
  const recipientTags = useMemo(
    () => recipients.filter((r): r is string => typeof r === 'string'),
    [recipients],
  );
  const recipientPeople = useMemo(
    () => {
      const results = [...recipientIndividuals];
      results.push(...getItemsById<PersonItem>(recipientGroups.flatMap(g => g.members)));
      results.push(...people.filter(p => p.tags.some(t => recipientTags.includes(t))));
      return Array.from(new Set(results));
    },
    [getItemsById, people, recipientIndividuals, recipientGroups, recipientTags],
  );
  const recipientsWithEmail = useMemo(
    () => recipientPeople.filter(p => !!p.email),
    [recipientPeople],
  );

  const handleSend = useCallback(
    () => {
      if (emailSettings) {
        vault?.koinonia.sendMessage({
          message: message.message,
          details: {
            content: message.data.html || '',
            recipients: getRecipientFields(recipientsWithEmail),
            subject: message.name,
            from: `${emailSettings.name} <${emailSettings.email}>`,
            smtp: {
              host: emailSettings.host,
              pass: emailSettings.pass,
              user: emailSettings.user,
            },
          },
        });
      } else {
        dispatch(setMessage({
          message: 'Email settings have not yet been set.',
          severity: 'error',
        }));
      }
      onClose();
    },
    [dispatch, emailSettings, message, onClose, recipientsWithEmail, vault],
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
        <Stack spacing={2} paddingTop={1}>
          <Search<RecipientTypes>
            autoFocus
            label="Select message recipients"
            noItemsText="No items found"
            onClear={handleClearRecipients}
            onRemove={handleRemoveRecipient}
            onSelect={handleAddRecipient}
            selectedItems={recipients}
            showSelectedChips
            types={{ person: true, group: true, tag: true }}
          />

          {recipientPeople.length > 0 && (
            <Alert
              severity={recipientsWithEmail.length === recipientPeople.length ? 'info' : 'warning'}
            >
              {recipientPeople.length} recipients selected
              {' '}
              (
              {recipientPeople.length - recipientsWithEmail.length}
              {' recipients don\'t have an email address)'}
            </Alert>
          )}
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
          startIcon={<MessageIcon />}
          variant="contained"
        >
          Send to {recipientsWithEmail.length} recipients
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default SendMessageDialog;

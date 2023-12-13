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
import {
  GroupItem,
  PersonItem,
} from '../../state/items';
import { useItems, useItemsById, useMetadata } from '../../state/selectors';
import { MessageIcon } from '../Icons';
import { getRecipientFields, MessageFull } from '../../state/koinonia';
import Search, { getSearchableDataId } from '../Search';
import { useAppDispatch } from '../../store';
import { setMessage } from '../../state/ui';
import { SendProgressCallback, sendMessage } from '../../api/KoinoniaAPI';

export interface Props {
  html: string,
  message: MessageFull,
  onClose: () => void,
  onSendProgress: SendProgressCallback,
  open: boolean,
}

type RecipientTypes = PersonItem | GroupItem | string;

function SendMessageDialog({
  html,
  message,
  onClose,
  onSendProgress,
  open,
}: Props) {
  const dispatch = useAppDispatch();
  const people = useItems<PersonItem>('person');
  const getItemsById = useItemsById();
  const [emailSettings] = useMetadata('emailSettings');

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
        sendMessage({
          message: message.message,
          details: {
            content: html,
            recipients: getRecipientFields(recipientsWithEmail),
            subject: message.name,
            from: `${emailSettings.name} <${emailSettings.email}>`,
            smtp: {
              host: emailSettings.host,
              pass: emailSettings.pass,
              user: emailSettings.user,
            },
          },
          progressCallback: onSendProgress,
        });
      } else {
        dispatch(setMessage({
          message: 'Email settings have not yet been set.',
          severity: 'error',
        }));
      }
      onClose();
    },
    [dispatch, emailSettings, html, message, onClose, onSendProgress, recipientsWithEmail],
  );

  return (
    <Dialog
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
              {recipientPeople.length - recipientsWithEmail.length > 0 && (
                ` (${recipientPeople.length - recipientsWithEmail.length}`
                + ' recipients don\'t have an email address)'
              )}
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

import {
  ChangeEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';
import {
  Button,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { MessageItem, PersonItem } from '../../state/items';
import { useAppDispatch, useAppSelector } from '../../store';
import { useItemsById } from '../../state/selectors';
import BaseDrawer, { BaseDrawerProps } from './BaseDrawer';
import { usePrevious } from '../../utils';
import { getIconType } from '../Icons';
import { MessageFull } from '../../state/messages';
import { pushActive } from '../../state/ui';
import { TrackingItem } from '../../../../koinonia/sender/types';
import ItemList from '../ItemList';
import { deleteMessage, getStats, saveMessage } from '../../api/KoinoniaAPI';


export interface Props extends BaseDrawerProps {
  message: MessageItem,
}


function MessageDrawer({
  message: messageItem,
  onBack,
  onClose,
  onExited,
  open,
  stacked,
}: Props) {
  const [cancelled, setCancelled] = useState(false);
  const dispatch = useAppDispatch();
  const getItemsById = useItemsById();
  const messages = useAppSelector(state => state.messages.entities);
  const [pendingSave, setPendingSave] = useState(false);
  const [stats, setStats] = useState<TrackingItem>();

  const message = useMemo(
    () => messages[messageItem.id],
    [messages, messageItem.id],
  );
  const [name, setName] = useState<string>(message?.name || '');
  const prevMessage = usePrevious(message);

  const recipients = useMemo(
    () => {
      const recipientIds = message?.sentTo || [];
      return getItemsById<PersonItem>(recipientIds);
    },
    [getItemsById, message?.sentTo],
  );

  useEffect(
    () => setName(message?.name || ''),
    [message?.name],
  );
  useEffect(
    () => setCancelled(false),
    [message?.message],
  );

  const handleChangeName = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      setName(event.target.value);
      setPendingSave(true);
    },
    [],
  );
  const handleClickEdit = useCallback(
    () => {
      dispatch(pushActive({
        item: messageItem.id,
      }));
    },
    [dispatch, messageItem.id],
  );

  const handleSave = useCallback(
    (callback?: () => void, overrideMessage?: MessageFull) => {
      const workingMessage = overrideMessage || message;
      if (workingMessage?.message) {
        const newMessage: MessageFull = {
          created: workingMessage.created || new Date().getTime(),
          data: workingMessage.data,
          message: workingMessage.message,
          name,
          sentTo: workingMessage.sentTo,
        };
        saveMessage(newMessage);
        callback?.();
        setPendingSave(false);
      }
    },
    [message, name],
  );
  const handleSaveAndClose = useCallback(
    () => {
      handleSave(onClose);
    },
    [handleSave, onClose],
  );
  const handleSaveButton = useCallback(
    () => {
      if (pendingSave) {
        handleSave();
      } else {
        handleSaveAndClose();
      }
    },
    [handleSave, handleSaveAndClose, pendingSave],
  );
  const handleCancel = useCallback(() => setCancelled(true), []);
  const handleDelete = useCallback(
    () => {
      if (message?.message) {
        deleteMessage({ message: message.message });
      }
      setCancelled(true);
    },
    [message?.message],
  );
  const handleUnmount = useCallback(
    () => {
      if (!cancelled) {
        handleSave();
      }
    },
    [cancelled, handleSave],
  );

  const orderedRecipients = useMemo(
    () => {
      const recipientsWithOpens = recipients.map(
        (p): [PersonItem, number] => [p, stats?.opens.filter(id => id === p.id).length || 0],
      );
      return recipientsWithOpens.sort((a, b) => b[1] - a[1]).map(([person]) => person);
    },
    [recipients, stats?.opens],
  );
  const getRecipientDescription = useCallback(
    (person: PersonItem) => {
      const count = stats?.opens?.filter(id => id === person.id).length;
      return `Opens: ${count}`;
    },
    [stats?.opens],
  );

  useEffect(
    () => {
      if (cancelled) onClose();
    },
    [cancelled, onClose],
  );
  useEffect(
    () => {
      if (open && prevMessage && prevMessage.message !== messageItem.id) {
        handleSave(undefined, prevMessage);
      }
    },
    [handleSave, messageItem.id, open, prevMessage],
  );
  useEffect(
    () => {
      getStats({ message: messageItem.id }).then(
        newStats => setStats(newStats),
      );
    },
    [messageItem.id],
  );

  return (
    <BaseDrawer
      ActionProps={{
        canSave: !!name,
        itemIsNew: messageItem.isNew,
        itemName: name,
        onCancel: handleCancel,
        onDelete: handleDelete,
        onSave: handleSaveButton,
        promptSave: pendingSave,
      }}
      itemKey={messageItem.id}
      onBack={onBack}
      onClose={handleSaveAndClose}
      onExited={onExited}
      onUnmount={handleUnmount}
      open={open}
      stacked={stacked}
      typeIcon={getIconType('message')}
    >
      <Stack spacing={2}>
        <TextField
          autoFocus
          data-cy="name"
          fullWidth
          key={messageItem.id}
          label="Message Name"
          onChange={handleChangeName}
          required
          value={name}
          variant="standard"
        />

        <Button
          onClick={handleClickEdit}
          variant="contained"
        >
          Edit or Send Message
        </Button>

        <div>
          <Typography color="text.secondary" paragraph>
            Message Id: {messageItem.id}
          </Typography>

          <Typography>
            Total Sent to: {recipients.length}
          </Typography>

          {stats && (
            <Typography>
              Total opens: {stats?.openCount}
            </Typography>
          )}
        </div>

        <div>
          <Typography variant="h6">
            Recipients
          </Typography>
          <ItemList
            dividers
            items={orderedRecipients}
            getDescription={getRecipientDescription}
            noItemsText="Not yet sent to anyone!"
          />
        </div>
      </Stack>
    </BaseDrawer>
  );
}

export default MessageDrawer;

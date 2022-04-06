import {
  ChangeEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';
import {
  Stack, TextField,
} from '@mui/material';
import makeStyles from '@mui/styles/makeStyles';
import {
  MessageItem,
} from '../../state/items';
import { useVault } from '../../state/selectors';
import BaseDrawer, { BaseDrawerProps } from './BaseDrawer';
import { getIconType } from '../Icons';
import { MessageFull } from '../../state/koinonia';
import { useAppSelector } from '../../store';
import SendMessageDialog from '../dialogs/SendMessageDialog';

export const useStyles = makeStyles(theme => ({
  alert: {
    transition: theme.transitions.create('all'),
    marginTop: theme.spacing(1),
  },
  emphasis: {
    fontWeight: 500,
  },
}));

export interface Props extends BaseDrawerProps {
  message: MessageItem,
}


function MessageDrawer({
  alwaysTemporary,
  message: messageItem,
  onBack,
  onClose,
  onExited,
  open,
  stacked,
}: Props) {
  const messages = useAppSelector(state => state.messages);
  const vault = useVault();

  const message = useMemo(
    () => messages.find(m => m.message === messageItem.message),
    [messages, messageItem.message],
  );

  const [name, setName] = useState<string>(message?.name || '');
  const [cancelled, setCancelled] = useState(false);
  const [showSend, setShowSend] = useState(false);

  const [content, setContent] = useState<string>();

  useEffect(
    () => setName(message?.name || ''),
    [message?.name],
  );
  useEffect(
    () => setCancelled(false),
    [message?.message],
  );
  useEffect(
    () => setContent(message?.data.html || ''),
    [message?.data.html],
  );

  const handleChangeName = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setName(event.target.value),
    [],
  );
  const handleChangeContent = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setContent(event.target.value),
    [],
  );
  const handleSave = useCallback(
    () => {
      if (message?.message) {
        const newMessage: MessageFull = {
          message: message.message,
          name,
          data: { html: content },
          created: new Date().getTime(),
        };
        vault?.koinonia.saveMessage(newMessage);
      }
    },
    [content, message?.message, name, vault],
  );
  const handleSaveAndClose = useCallback(
    () => {
      handleSave();
      onClose();
    },
    [handleSave, onClose],
  );
  const handleSaveButton = useCallback(
    () => handleSave(),
    [handleSave],
  );
  const handleCancel = useCallback(() => setCancelled(true), []);
  const handleDelete = useCallback(
    () => {
      if (message?.message) {
        vault?.koinonia.deleteMessage({ message: message.message });
      }
      setCancelled(true);
    },
    [message?.message, vault],
  );
  const handleShowSend = useCallback(() => setShowSend(true), []);
  const handleCloseSend = useCallback(() => setShowSend(false), []);
  const handleUnmount = useCallback(
    () => {
      if (!cancelled) {
        handleSave();
      }
    },
    [cancelled, handleSave],
  );

  useEffect(
    () => {
      if (cancelled) onClose();
    },
    [cancelled, onClose],
  );
  useEffect(
    () => {
      // if (open && prevItem && prevItem.id !== item.id) {
      //   handleSave(prevItem);
      // }
    },
    [],
  );
  useEffect(
    () => {
      const timeout = setTimeout(
        () => handleSave(),
        10000,
      );
      return () => clearTimeout(timeout);
    },
    [handleSave],
  );

  return (
    <BaseDrawer
      ActionProps={{
        canSave: true,
        itemIsNew: false,
        itemName: name,
        onCancel: handleCancel,
        onDelete: handleDelete,
        onSave: handleSaveButton,
        onSend: handleShowSend,
      }}
      alwaysTemporary={alwaysTemporary}
      itemKey={message?.message}
      onBack={onBack}
      onClose={handleSaveAndClose}
      onExited={onExited}
      onUnmount={handleUnmount}
      open={open}
      stacked={stacked}
      typeIcon={getIconType(messageItem.type)}
    >
      <Stack spacing={2}>
        <TextField
          autoFocus
          data-cy="name"
          fullWidth
          label="Message Name"
          onChange={handleChangeName}
          required
          value={name}
          variant="standard"
        />

        <TextField
          fullWidth
          label="Message Content (HTML)"
          multiline
          onChange={handleChangeContent}
          value={content}
          variant="standard"
        />
      </Stack>

      <SendMessageDialog
        message={message!}
        onClose={handleCloseSend}
        open={showSend}
      />
    </BaseDrawer>
  );
}

export default MessageDrawer;

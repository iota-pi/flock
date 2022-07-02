import {
  ChangeEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Alert,
  Stack, TextField,
} from '@mui/material';
import makeStyles from '@mui/styles/makeStyles';
import EmailEditor from 'react-email-editor';
import { MessageItem } from '../../state/items';
import { useMetadata, useVault } from '../../state/selectors';
import BaseDrawer, { BaseDrawerProps } from './BaseDrawer';
import { getIconType } from '../Icons';
import { MessageFull } from '../../state/koinonia';
import { useAppSelector } from '../../store';
import SendMessageDialog from '../dialogs/SendMessageDialog';
import template from '../../utils/unlayer-template.json';
import { SendProgressCallback } from '../../api/KoinoniaAPI';

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
  message: messageItem,
  onBack,
  onClose,
  onExited,
  open,
  stacked,
}: Props) {
  const emailEditorRef = useRef<EmailEditor>(null);
  const [emailSettings] = useMetadata('emailSettings');
  const messages = useAppSelector(state => state.messages);
  const vault = useVault();
  const [sendStats, setSendStats] = useState({ successCount: 0, errorCount: 0 });

  const message = useMemo(
    () => messages.find(m => m.message === messageItem.id),
    [messages, messageItem.id],
  );

  const [name, setName] = useState<string>(message?.name || '');
  const [cancelled, setCancelled] = useState(false);
  const [htmlToSend, setHTMLToSend] = useState('');

  useEffect(
    () => setName(message?.name || ''),
    [message?.name],
  );
  useEffect(
    () => setCancelled(false),
    [message?.message],
  );

  const handleEditorReady = useCallback(
    () => {
      const data = message?.data;
      if (data) {
        emailEditorRef.current?.loadDesign(data);
      } else {
        emailEditorRef.current?.loadDesign(template);
      }
    },
    [emailEditorRef, message?.data],
  );
  const handleChangeName = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setName(event.target.value),
    [],
  );
  const handleSave = useCallback(
    (callback?: () => void) => {
      if (message?.message) {
        emailEditorRef.current?.saveDesign(data => {
          const newMessage: MessageFull = {
            created: new Date().getTime(),
            data,
            message: message.message,
            name,
            sentTo: message.sentTo,
          };
          vault?.koinonia.saveMessage(newMessage);
          callback?.();
        });
      }
    },
    [emailEditorRef, message?.message, message?.sentTo, name, vault],
  );
  const handleSaveAndClose = useCallback(
    () => {
      handleSave(onClose);
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
  const handleShowSend = useCallback(
    () => {
      emailEditorRef.current?.exportHtml(({ html }) => setHTMLToSend(html));
    },
    [emailEditorRef, setHTMLToSend],
  );
  const handleCloseSend = useCallback(() => setHTMLToSend(''), []);
  const handleSendProgress: SendProgressCallback = useCallback(
    progress => {
      setSendStats(stats => ({
        successCount: stats.successCount + progress.successCount,
        errorCount: stats.errorCount + progress.errorCount,
      }));
    },
    [],
  );
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

  return (
    <BaseDrawer
      ActionProps={{
        canSave: true,
        canSend: !!emailSettings && Object.entries(emailSettings).every(s => !!s),
        itemIsNew: false,
        itemName: name,
        onCancel: handleCancel,
        onDelete: handleDelete,
        onSave: handleSaveButton,
        onSend: handleShowSend,
      }}
      alwaysTemporary
      alwaysShowBack
      fullScreen
      itemKey={message?.message}
      onBack={onBack}
      onClose={handleSaveAndClose}
      onExited={onExited}
      onUnmount={handleUnmount}
      open={open}
      stacked={stacked}
      typeIcon={getIconType(messageItem.type)}
    >
      <Stack spacing={2} flexGrow={1}>
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

        <EmailEditor
          onReady={handleEditorReady}
          projectId={70208}
          ref={emailEditorRef}
        />

        {sendStats.successCount + sendStats.errorCount > 0 && (
          <Alert severity={sendStats.errorCount === 0 ? 'success' : 'warning'}>
            Successfully sent to {sendStats.successCount} recipients
            {sendStats.errorCount > 0 ? ` (${sendStats.errorCount} errors)` : ''}
            .
          </Alert>
        )}
      </Stack>

      {message && (
        <SendMessageDialog
          html={htmlToSend}
          message={message}
          onClose={handleCloseSend}
          onSendProgress={handleSendProgress}
          open={!!htmlToSend}
        />
      )}
    </BaseDrawer>
  );
}

export default MessageDrawer;

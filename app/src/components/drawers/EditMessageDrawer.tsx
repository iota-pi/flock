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
  Stack,
  TextField,
} from '@mui/material';
import debounce from 'debounce';
import objectHash from 'object-hash';
import EmailEditor, { Design } from 'react-email-editor';
import type { MessageItem } from '../../state/items';
import { useMetadata, useVault } from '../../state/selectors';
import BaseDrawer, { BaseDrawerProps } from './BaseDrawer';
import { getIconType } from '../Icons';
import type { MessageFull } from '../../state/koinonia';
import { useAppSelector } from '../../store';
import SendMessageDialog from '../dialogs/SendMessageDialog';
import template from '../../utils/unlayer-template.json';
import type { SendProgressCallback } from '../../api/KoinoniaAPI';

export interface Props extends BaseDrawerProps {
  message: MessageItem,
}


function EditMessageDrawer({
  message: messageItem,
  onBack,
  onClose,
  onExited,
  open,
  stacked,
}: Props) {
  const [editorReady, setEditorReady] = useState(false);
  const emailEditorRef = useRef<EmailEditor>(null);
  const [emailSettings] = useMetadata('emailSettings');
  const lastDesignHash = useRef<string>();
  const messages = useAppSelector(state => state.messages);
  const [pendingSave, setPendingSave] = useState(false);
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
      const editor = emailEditorRef.current;
      if (editor) {
        if (data && Object.keys(data).length > 0) {
          editor.loadDesign(data);
        } else {
          editor.loadDesign(template);
        }
        setEditorReady(true);
      } else {
        console.warn('Email editor ready event called while ref is not set');
      }
    },
    [message?.data],
  );
  const handleChangeName = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      setName(event.target.value);
      setPendingSave(true);
    },
    [],
  );
  const handleSave = useCallback(
    (callback?: () => void) => {
      if (message?.message) {
        emailEditorRef.current?.saveDesign(design => {
          if (design && Object.keys(design).length > 0) {
            const newMessage: MessageFull = {
              created: message.created || new Date().getTime(),
              data: design,
              message: message.message,
              name,
              sentTo: message.sentTo,
            };
            vault?.koinonia.saveMessage(newMessage);
            callback?.();
            setPendingSave(false);
          }
        });
      }
    },
    [message?.created, message?.message, message?.sentTo, name, vault],
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

  const autoSave = useMemo(
    () => debounce(handleSave, 10000),
    [handleSave],
  );
  const handleDesignUpdate = useCallback(
    () => {
      setPendingSave(true);
      autoSave();
    },
    [autoSave],
  );
  useEffect(
    () => {
      const interval = setInterval(
        () => {
          if (editorReady) {
            emailEditorRef.current?.saveDesign((design: Design | undefined) => {
              if (design) {
                const currentDesignHash = objectHash(design);
                if (lastDesignHash.current !== currentDesignHash) {
                  lastDesignHash.current = currentDesignHash;
                  handleDesignUpdate();
                }
              }
            });
          }
        },
        1000,
      );
      return () => clearInterval(interval);
    },
    [editorReady, handleDesignUpdate],
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
        disableAutoCloseOnSave: true,
        itemIsNew: false,
        itemName: name,
        promptSave: pendingSave,
        onCancel: handleCancel,
        onDelete: handleDelete,
        onSave: handleSaveButton,
        onSend: handleShowSend,
      }}
      alwaysTemporary
      alwaysShowBack
      disableAutoCloseOnSave
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

export default EditMessageDrawer;

import {
  useCallback,
  useEffect,
  useState,
} from 'react';
import {
  Grid,
} from '@mui/material';
import makeStyles from '@mui/styles/makeStyles';
import {
  MessageItem,
} from '../../state/items';
import { useVault } from '../../state/selectors';
import BaseDrawer, { BaseDrawerProps } from './BaseDrawer';
import { getIconType } from '../Icons';

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
  message,
  onBack,
  onClose,
  onExited,
  open,
  stacked,
}: Props) {
  const vault = useVault();

  const [name, setName] = useState<string>(message.name);
  const [cancelled, setCancelled] = useState(false);

  useEffect(
    () => setName(message.name),
    [message.name],
  );

  const handleSave = useCallback(
    () => {
      vault?.koinonia.saveMessage({
        message: message.message,
        name,
        data: {},
      });
    },
    [message.message, name, vault],
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
      // vault?.koinonia.deleteMessage({ message: message.message });
      onClose();
    },
    [onClose],
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
        itemName: message.name,
        onCancel: handleCancel,
        onDelete: handleDelete,
        onSave: handleSaveButton,
      }}
      alwaysTemporary={alwaysTemporary}
      itemKey={message.message}
      onBack={onBack}
      onClose={handleSaveAndClose}
      onExited={onExited}
      onUnmount={handleUnmount}
      open={open}
      stacked={stacked}
      typeIcon={getIconType(message.type)}
    >
      <Grid container spacing={2}>
        Hi
      </Grid>
    </BaseDrawer>
  );
}

export default MessageDrawer;

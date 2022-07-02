import { List, ListItemButton, ListItemText } from '@mui/material';
import { useCallback, useState } from 'react';
import BasePage from './BasePage';
import { useAppDispatch, useAppSelector } from '../../store';
import { useVault } from '../../state/selectors';
import { replaceActive } from '../../state/ui';
import { EmailIcon } from '../Icons';
import SMTPDialog from '../dialogs/SMTPDialog';

interface MessageSummary {
  message: string,
  name: string,
}

function CommunicationPage() {
  const dispatch = useAppDispatch();
  const messages = useAppSelector(state => state.messages);
  const vault = useVault();

  const [showSMTP, setShowSMTP] = useState(false);

  const handleClick = useCallback(
    (m: MessageSummary) => {
      dispatch(replaceActive({ item: m.message }));
    },
    [dispatch],
  );
  const handleClickAdd = useCallback(
    async () => {
      const name = 'New message';
      const message = await vault?.koinonia.createMessage({
        name,
        data: null,
        sentTo: [],
      });
      if (message) {
        dispatch(replaceActive({
          item: message,
          newItem: { type: 'message', id: message, name },
        }));
      }
    },
    [dispatch, vault],
  );
  const handleShowSMTP = useCallback(() => setShowSMTP(true), []);
  const handleHideSMTP = useCallback(() => setShowSMTP(false), []);

  return (
    <BasePage
      fab
      fabLabel="Add action"
      onClickFab={handleClickAdd}
      topBar
      menuItems={[
        {
          closeOnClick: true,
          icon: EmailIcon,
          key: 'smtp-settings',
          label: 'Email (SMTP) settings',
          onClick: handleShowSMTP,
        },
      ]}
    >
      <List>
        {messages.map(message => (
          <ListItemButton
            key={message.message}
            onClick={() => handleClick(message)}
          >
            <ListItemText
              primary={message.name}
              secondary={message.message}
            />
          </ListItemButton>
        ))}
      </List>

      <SMTPDialog
        onClose={handleHideSMTP}
        open={showSMTP}
      />
    </BasePage>
  );
}

export default CommunicationPage;

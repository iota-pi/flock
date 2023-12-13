import { List, ListItemButton, ListItemText } from '@mui/material';
import { useCallback, useState } from 'react';
import { useSelector } from 'react-redux';
import BasePage from './BasePage';
import { useAppDispatch } from '../../store';
import { replaceActive } from '../../state/ui';
import { EmailIcon } from '../Icons';
import SMTPDialog from '../dialogs/SMTPDialog';
import { createMessage } from '../../api/KoinoniaAPI';
import { selectAllMessages } from '../../state/messages';

interface MessageSummary {
  message: string,
  name: string,
}

function CommunicationPage() {
  const dispatch = useAppDispatch();
  const messages = useSelector(selectAllMessages);

  const [showSMTP, setShowSMTP] = useState(false);

  const handleClick = useCallback(
    (m: MessageSummary) => {
      dispatch(replaceActive({ item: m.message, report: true }));
    },
    [dispatch],
  );
  const handleClickAdd = useCallback(
    async () => {
      const name = 'New message';
      const message = await createMessage({
        name,
        data: null,
        sentTo: [],
      });
      if (message) {
        dispatch(replaceActive({
          item: message,
          newItem: { type: 'message', id: message, name, isNew: true },
        }));
      }
    },
    [dispatch],
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

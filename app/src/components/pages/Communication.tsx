import { List, ListItemButton, ListItemText } from '@mui/material';
import { useCallback } from 'react';
import BasePage from './BasePage';
import { useAppDispatch, useAppSelector } from '../../store';
import { useVault } from '../../state/selectors';
import { replaceActive } from '../../state/ui';

interface MessageSummary {
  message: string,
  name: string,
}

function CommunicationPage() {
  const dispatch = useAppDispatch();
  const messages = useAppSelector(state => state.messages);
  const vault = useVault();

  const handleClick = useCallback(
    (m: MessageSummary) => {
      dispatch(replaceActive({
        item: m.message,
        newItem: { type: 'message', ...m },
      }));
    },
    [dispatch],
  );
  const handleClickAdd = useCallback(
    async () => {
      const name = 'New message';
      const message = await vault?.koinonia.createMessage({
        name,
        data: {},
      });
      if (message) {
        dispatch(replaceActive({
          item: message,
          newItem: { type: 'message', message, name },
        }));
      }
    },
    [dispatch, vault],
  );

  return (
    <BasePage
      fab
      fabLabel="Add action"
      onClickFab={handleClickAdd}
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
    </BasePage>
  );
}

export default CommunicationPage;

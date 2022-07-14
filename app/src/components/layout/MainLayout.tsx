import { PropsWithChildren } from 'react';
import { Box } from '@mui/material';
import DrawerDisplay from './DrawerDisplay';
import SelectedActions from '../SelectedActions';
import GeneralMessage from '../GeneralMessage';
import { useLoggedIn } from '../../state/selectors';


function MainLayout({ children }: PropsWithChildren<{}>) {
  const loggedIn = useLoggedIn();

  return (
    <Box
      display="flex"
      flexGrow={1}
      overflow="hidden"
    >
      <Box
        display="flex"
        flexDirection="column"
        flexGrow={1}
        position="relative"
      >
        <Box
          display="flex"
          flexDirection="column"
          flexGrow={1}
          overflow="hidden"
          position="relative"
        >
          {children}
        </Box>

        <Box flexShrink={0} overflow="hidden">
          <SelectedActions />
        </Box>
      </Box>

      {loggedIn && (
        <DrawerDisplay />
      )}

      <GeneralMessage />
    </Box>
  );
}

export default MainLayout;

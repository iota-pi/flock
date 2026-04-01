import { lazy, Suspense, type ReactNode } from 'react'
import { Box } from '@mui/material'
import SelectedActions from '../SelectedActions'
import GeneralMessage from '../GeneralMessage'
import { useLoggedIn } from '../../state/selectors'

const DrawerDisplay = lazy(() => import('./DrawerDisplay'))


function MainLayout({ children }: { children: ReactNode }) {
  const loggedIn = useLoggedIn()

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
        <Suspense fallback={null}>
          <DrawerDisplay />
        </Suspense>
      )}

      <GeneralMessage />
    </Box>
  )
}

export default MainLayout

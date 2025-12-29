import { Suspense } from 'react'
import { Navigate, useLocation, useMatches, RouteObject } from 'react-router'
import { CircularProgress, Box } from '@mui/material'
import { useLoggedIn } from '../../state/selectors'

import { INTERNAL_ROUTES, MENU_ROUTES } from './routes'
import { Page, PageId } from './types'

export const pages: Page[] = (Object.entries(MENU_ROUTES) as [PageId, typeof MENU_ROUTES[PageId]][])
  .map(([id, config]) => ({ ...config, id }))


function Loading() {
  return (
    <Box display="flex" justifyContent="center" alignItems="center" height="100%" width="100%">
      <CircularProgress />
    </Box>
  )
}

function RequireAuth({ children }: { children: React.ReactNode }) {
  const loggedIn = useLoggedIn()
  const location = useLocation()

  if (!loggedIn) {
    return <Navigate to="/welcome" state={{ from: location }} replace />
  }

  return <>{children}</>
}

export const routes: RouteObject[] = [
  // Public routes
  ...Object.values(INTERNAL_ROUTES).filter(p => !p.requiresAuth).map(p => ({
    path: p.path,
    element: (
      <Suspense fallback={<Loading />}>
        {p.page}
      </Suspense>
    ),
    handle: p,
  })),
  // Protected routes
  ...Object.values(MENU_ROUTES).map(p => ({
    path: p.path,
    element: (
      <RequireAuth>
        <Suspense fallback={<Loading />}>
          {p.page}
        </Suspense>
      </RequireAuth>
    ),
    handle: p,
  })),
  {
    path: "*",
    element: <Navigate to="/" replace />
  }
]


export function usePage(): Page | undefined {
  const matches = useMatches()

  // Find the last match that has a handle which looks like a Page
  const match = matches.findLast(m => {
    const handle = m.handle as Page | undefined
    return handle?.id && handle?.name
  })

  return match?.handle as Page | undefined
}

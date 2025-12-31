import { Suspense } from 'react'
import { Navigate, useLocation, useMatches, RouteObject } from 'react-router'
import { CircularProgress, Box } from '@mui/material'
import { useLoggedIn, useAuthInitializing } from '../../state/selectors'

import { PUBLIC_ROUTES, PROTECTED_ROUTES } from './routes'
import { Page, PageId } from './types'

export const pages: Page[] = (Object.entries(PROTECTED_ROUTES) as [PageId, typeof PROTECTED_ROUTES[PageId]][])
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
  const initializing = useAuthInitializing()
  const location = useLocation()

  if (initializing) {
    return <Loading />
  }

  if (!loggedIn) {
    return <Navigate to="/welcome" state={{ from: location }} replace />
  }

  return <>{children}</>
}

function RedirectIfLoggedIn(
  { children, redirect }: {
    children: React.ReactNode,
    redirect: string,
  },
) {
  const loggedIn = useLoggedIn()
  const initializing = useAuthInitializing()

  if (initializing) {
    return <Loading />
  }

  if (loggedIn) {
    return <Navigate to={redirect} replace />
  }

  return <>{children}</>
}

export const routes: RouteObject[] = [
  // Public routes
  ...Object.entries(PUBLIC_ROUTES).map(([id, p]) => ({
    path: p.path,
    element: (
      <RedirectIfLoggedIn redirect="/">
        <Suspense fallback={<Loading />}>
          {p.page}
        </Suspense>
      </RedirectIfLoggedIn>
    ),
    handle: { ...p, id },
  })),
  // Protected routes
  ...Object.entries(PROTECTED_ROUTES).map(([id, p]) => ({
    path: p.path,
    element: (
      <RequireAuth>
        <Suspense fallback={<Loading />}>
          {p.page}
        </Suspense>
      </RequireAuth>
    ),
    handle: { ...p, id },
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

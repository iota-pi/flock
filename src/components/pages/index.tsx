import { Navigate, useLocation, useMatches, RouteObject } from 'react-router'
import { CircularProgress, Box } from '@mui/material'
import { useLoggedIn } from '../../state/selectors'
import { useAuthStore } from '../../state/authStore'

import { PUBLIC_ROUTES, PROTECTED_ROUTES } from './routes'
import { resolveRedirectRoute, type RedirectRouteState } from './redirectUtils'
import { Page, PageId } from './types'
import ErrorPage from './ErrorPage'
import AsyncBoundary, { LoadingSpinner } from '../ui/AsyncBoundary'

export const pages: Page[] = (Object.entries(PROTECTED_ROUTES) as [PageId, typeof PROTECTED_ROUTES[PageId]][])
  .map(([id, config]) => ({ ...config, id }))


function RequireAuth({ children }: { children: React.ReactNode }) {
  const loggedIn = useLoggedIn()
  const initializing = useAuthStore(state => state.initializing)
  const location = useLocation()

  if (initializing) {
    return <LoadingSpinner />
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
  const initializing = useAuthStore(state => state.initializing)
  const location = useLocation()

  if (initializing) {
    return <LoadingSpinner />
  }

  if (loggedIn) {
    const nextRoute = resolveRedirectRoute(
      location.state as RedirectRouteState | null,
      redirect,
      location.pathname,
    )

    return <Navigate to={nextRoute} replace />
  }

  return <>{children}</>
}

export const routes: RouteObject[] = [
  // Public routes
  ...Object.entries(PUBLIC_ROUTES).map(([id, p]) => ({
    path: p.path,
    element: (
      <RedirectIfLoggedIn redirect="/">
        <AsyncBoundary>
          {p.page}
        </AsyncBoundary>
      </RedirectIfLoggedIn>
    ),
    errorElement: <ErrorPage />,
    handle: { ...p, id },
  })),
  // Protected routes
  ...Object.entries(PROTECTED_ROUTES).map(([id, p]) => ({
    path: p.path,
    element: (
      <RequireAuth>
        <AsyncBoundary>
          {p.page}
        </AsyncBoundary>
      </RequireAuth>
    ),
    errorElement: <ErrorPage />,
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

import type { ReactNode } from 'react'
import type { MuiIconType } from '../Icons'

export type PublicPageId = (
  | 'welcome'
  | 'login'
  | 'signup'
)
export type ProtectedPageId = (
  | 'prayer'
  | 'people'
  | 'groups'
  | 'topics'
  | 'settings'
)

interface BasePageConfig {
  path: string
  requiresAuth: boolean
}

// Config shape for internal routes (no ID)
export interface InternalRouteConfig extends BasePageConfig {
  page: ReactNode
  requiresAuth: false
}

// Config shape for menu routes (no ID)
export interface MenuRouteConfig extends BasePageConfig {
  icon: MuiIconType
  page: ReactNode
  name: string
  dividerBefore?: boolean
  noPlaceholderDrawer?: boolean
  requiresAuth: true
}

export interface Page extends MenuRouteConfig {
  id: ProtectedPageId
}

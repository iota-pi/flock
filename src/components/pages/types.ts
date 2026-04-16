import type { ReactNode } from 'react'
import type { AccountMetadata } from 'src/state/metadata'
import type { MuiIconType } from '../Icons'
import type { InternalPageId, PageId } from './routes'

export type { InternalPageId, PageId }

export interface BasePageConfig {
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
  id: PageId
}

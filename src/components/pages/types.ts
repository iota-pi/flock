import type { ReactNode } from 'react'
import type { AccountMetadata } from 'src/state/account'
import type { MuiIconType } from '../Icons'
import type { InternalPageId, PageId, AnyPageId } from './routes'

export type { InternalPageId, PageId, AnyPageId }

export interface BasePageConfig {
  path: string
  requiresAuth: boolean
}

// Config shape for internal routes (no ID)
export interface InternalRouteConfig extends BasePageConfig {
  page: ReactNode
}

// Config shape for menu routes (no ID)
export interface MenuRouteConfig extends BasePageConfig {
  icon: MuiIconType
  page: ReactNode
  name: string
  dividerBefore?: boolean
  noPlaceholderDrawer?: boolean
  metadataControl?: (metadata: AccountMetadata) => boolean
}

export interface InternalPage extends InternalRouteConfig {
  id: InternalPageId
}

export interface Page extends MenuRouteConfig {
  id: PageId
}

export interface BasePageConfig {
  path: string
  requiresAuth: boolean
}

// Config shape for internal routes (no ID)
export interface InternalRouteConfig extends BasePageConfig {
  page: ReactNode
}

// Config shape for menu routes (no ID)
export interface MenuRouteConfig extends BasePageConfig {
  icon: MuiIconType
  page: ReactNode
  name: string
  dividerBefore?: boolean
  noPlaceholderDrawer?: boolean
  metadataControl?: (metadata: AccountMetadata) => boolean
}

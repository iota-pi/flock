import { ReactNode } from 'react';
import { AccountMetadata } from 'src/state/account';
import { MuiIconType } from '../Icons';


export type InternalPageId = ('welcome' |
  'login' |
  'signup');
export type PageId = ('people' |
  'groups' |
  'prayer' |
  'settings');
export type AnyPageId = InternalPageId | PageId;

export interface InternalPage {
  dividerBefore?: boolean;
  id: AnyPageId;
  metadataControl?: (metadata: AccountMetadata) => boolean;
  noPlaceholderDrawer?: boolean;
  path: string;
  page: ReactNode;
  requiresAuth: boolean;
  visible?: boolean;
}

export interface Page extends InternalPage {
  id: PageId;
  name: string;
  icon: MuiIconType;
}

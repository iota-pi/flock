import { ReactNode, useMemo } from 'react';
import { Switch, Route, matchPath, useLocation } from 'react-router-dom';
import loadable from '@loadable/component';
import { useVault } from '../../state/selectors';
import {
  ActionIcon,
  GeneralIcon,
  GroupIcon,
  InteractionIcon,
  MuiIconType,
  OptionsIcon,
  PersonIcon,
  PrayerIcon,
} from '../Icons';

const ActionsPage = loadable(() => import('./Actions'));
const CreateAccountPage = loadable(() => import('./CreateAccount'));
const InteractionsPage = loadable(() => import('./Interactions'));
const ItemPage = loadable(() => import('./ItemPage'));
const LoginPage = loadable(() => import('./Login'));
const PrayerPage = loadable(() => import('./Prayer'));
const SettingsPage = loadable(() => import('./Settings'));
const TagPage = loadable(() => import('./Tag'));

export type InternalPageId = (
  'login' |
  'signup' |
  'tag'
);
export type PageId = (
  'people' |
  'groups' |
  'general' |
  'interactions' |
  'prayer' |
  'actions' |
  'settings'
);
export type AnyPageId = InternalPageId | PageId;

export interface InternalPage {
  id: AnyPageId,
  path: string,
  page: ReactNode,
  requiresAuth: boolean,
  dividerBefore?: boolean,
  visible?: boolean,
}

export interface Page extends InternalPage {
  id: PageId,
  name: string,
  icon: MuiIconType,
}

export const internalPages: InternalPage[] = [
  {
    id: 'login',
    path: '/login',
    page: <LoginPage />,
    requiresAuth: false,
  },
  {
    id: 'signup',
    path: '/signup',
    page: <CreateAccountPage />,
    requiresAuth: false,
  },
  {
    id: 'tag',
    path: '/tag/:tag',
    page: <TagPage />,
    requiresAuth: true,
  },
];

export const pages: Page[] = [
  {
    id: 'people',
    path: '/',
    name: 'People',
    icon: PersonIcon,
    page: <ItemPage itemType="person" />,
    requiresAuth: true,
  },
  {
    id: 'groups',
    path: '/groups',
    name: 'Groups',
    icon: GroupIcon,
    page: <ItemPage itemType="group" />,
    requiresAuth: true,
  },
  {
    id: 'general',
    path: '/general',
    name: 'Other Items',
    icon: GeneralIcon,
    page: <ItemPage itemType="general" />,
    requiresAuth: true,
  },
  {
    id: 'prayer',
    path: '/prayer',
    name: 'Prayer',
    icon: PrayerIcon,
    page: <PrayerPage />,
    dividerBefore: true,
    requiresAuth: true,
  },
  {
    id: 'interactions',
    path: '/interactions',
    name: 'Interactions',
    icon: InteractionIcon,
    page: <InteractionsPage />,
    requiresAuth: true,
  },
  {
    id: 'actions',
    path: '/actions',
    name: 'Actions',
    icon: ActionIcon,
    page: <ActionsPage />,
    requiresAuth: true,
  },
  {
    id: 'settings',
    path: '/settings',
    name: 'Settings',
    icon: OptionsIcon,
    page: <SettingsPage />,
    dividerBefore: true,
    requiresAuth: true,
  },
];

const allPages: (InternalPage | Page)[] = [
  ...internalPages,
  ...pages.slice().reverse(),
];

function PageView() {
  const vault = useVault();

  const pageRoutes = useMemo(
    () => allPages.map(page => (
      <Route
        key={page.id}
        path={page.path}
      >
        {!page.requiresAuth || vault ? page.page : getPage('login').page}
      </Route>
    )),
    [vault],
  );

  return (
    <Switch>
      {pageRoutes}
    </Switch>
  );
}

export default PageView;

export function getPage(page: AnyPageId) {
  const result = allPages.find(p => p.id === page);
  if (result === undefined) {
    throw new Error(`Unknown page id ${page}`);
  }
  return result;
}

export function getTagPage(tag: string) {
  return getPage('tag').path.replace(':tag', encodeURIComponent(tag));
}

export function useAnyPage() {
  const location = useLocation();
  const page = allPages.find(p => matchPath(location.pathname, p));
  if (page) {
    return page;
  }
  throw new Error('Could not find matching page');
}

export function usePage() {
  const location = useLocation();
  const page = pages.slice().reverse().find(p => matchPath(location.pathname, p));
  if (page) {
    return page;
  }
  throw new Error('Could not find matching page');
}

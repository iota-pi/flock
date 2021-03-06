import React, { ComponentType, ReactNode, useMemo } from 'react';
import { Switch, Route, matchPath, useLocation } from 'react-router-dom';
import loadable from '@loadable/component';
import { useVault } from '../../state/selectors';
import {
  ActionIcon,
  MessageIcon,
  GeneralIcon,
  GroupIcon,
  InteractionIcon,
  MuiIconType,
  OptionsIcon,
  PersonIcon,
  PrayerIcon,
} from '../Icons';
import CommunicationPage from './Communication';
import { AccountMetadata } from '../../state/account';

const ActionsPage = loadable(() => import('./Actions'));
const CreateAccountPage = loadable(() => import('./CreateAccount'));
const InteractionsPage = loadable(() => import('./Interactions'));
const ItemPage = loadable(() => import('./ItemPage'));
const LoginPage = loadable(() => import('./Login'));
const PrayerPage = loadable(() => import('./Prayer'));
const SettingsPage = loadable(() => import('./Settings'));
const WelcomePage = loadable(() => import('./Welcome'));

export type InternalPageId = (
  'welcome' |
  'login' |
  'signup'
);
export type PageId = (
  'people' |
  'groups' |
  'general' |
  'interactions' |
  'prayer' |
  'actions' |
  'communication' |
  'settings'
);
export type AnyPageId = InternalPageId | PageId;

export interface InternalPage {
  dividerBefore?: boolean,
  id: AnyPageId,
  metadataControl?: (metadata: AccountMetadata) => boolean,
  noPlaceholderDrawer?: boolean,
  path: string,
  page: ReactNode,
  requiresAuth: boolean,
  visible?: boolean,
}

export interface Page extends InternalPage {
  id: PageId,
  name: string,
  icon: MuiIconType,
}

export const internalPages: InternalPage[] = [
  {
    id: 'welcome',
    page: <WelcomePage />,
    path: '/welcome',
    requiresAuth: false,
  },
  {
    id: 'login',
    page: <LoginPage />,
    path: '/login',
    requiresAuth: false,
  },
  {
    id: 'signup',
    page: <CreateAccountPage />,
    path: '/signup',
    requiresAuth: false,
  },
];

export const pages: Page[] = [
  {
    icon: PersonIcon,
    id: 'people',
    name: 'People',
    page: <ItemPage itemType="person" />,
    path: '/',
    requiresAuth: true,
  },
  {
    icon: GroupIcon,
    id: 'groups',
    name: 'Groups',
    page: <ItemPage itemType="group" />,
    path: '/groups',
    requiresAuth: true,
  },
  {
    icon: GeneralIcon,
    id: 'general',
    name: 'Other Items',
    page: <ItemPage itemType="general" />,
    path: '/general',
    requiresAuth: true,
  },
  {
    dividerBefore: true,
    icon: PrayerIcon,
    id: 'prayer',
    name: 'Prayer',
    page: <PrayerPage />,
    path: '/prayer',
    requiresAuth: true,
  },
  {
    icon: InteractionIcon,
    id: 'interactions',
    name: 'Interactions',
    path: '/interactions',
    page: <InteractionsPage />,
    requiresAuth: true,
  },
  {
    icon: ActionIcon,
    id: 'actions',
    name: 'Actions',
    page: <ActionsPage />,
    path: '/actions',
    requiresAuth: true,
  },
  {
    dividerBefore: true,
    icon: MessageIcon,
    id: 'communication',
    name: 'Communication',
    page: <CommunicationPage />,
    path: '/communication',
    requiresAuth: true,
    metadataControl: metadata => !!metadata.showCommPage,
  },
  {
    dividerBefore: true,
    icon: OptionsIcon,
    id: 'settings',
    name: 'Settings',
    noPlaceholderDrawer: true,
    page: <SettingsPage />,
    path: '/settings',
    requiresAuth: true,
  },
];

const reversedPages = pages.slice().reverse();
const allPages: (InternalPage | Page)[] = [
  ...internalPages,
  ...reversedPages,
];

function PageView() {
  const vault = useVault();

  const pageRoutes = useMemo(
    () => allPages.map(page => (
      <Route
        key={page.id}
        path={page.path}
      >
        {!page.requiresAuth || vault ? page.page : getPage('welcome').page}
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

export function useAnyPage() {
  const location = useLocation();
  const page = useMemo(
    () => allPages.find(p => matchPath(location.pathname, p)),
    [location.pathname],
  );
  if (page) {
    return page;
  }
  throw new Error('Could not find matching page');
}

export function usePage() {
  const location = useLocation();
  const page = useMemo(
    () => reversedPages.find(p => matchPath(location.pathname, p)),
    [location.pathname],
  );
  if (page) {
    return page;
  }
  throw new Error('Could not find matching page');
}

interface PageProps {
  page: Page,
}
export type WithPage<P> = P & PageProps;
export const withPage = <P extends PageProps>(
  Component: ComponentType<P>,
) => {
  type BaseProps = Omit<P, keyof PageProps>;
  const WithPageHOC: React.FC<BaseProps> = (props: BaseProps) => {
    const page = usePage();
    return <Component {...props as P} page={page} />;
  };
  return WithPageHOC;
};

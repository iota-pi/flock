import React, { ComponentType, ReactNode, useMemo } from 'react';
import { Switch, Route, matchPath, useLocation } from 'react-router-dom';
import loadable from '@loadable/component';
import { useVault } from '../../state/selectors';
import {
  ActionIcon,
  EmailIcon,
  GeneralIcon,
  GroupIcon,
  InteractionIcon,
  MuiIconType,
  OptionsIcon,
  PersonIcon,
  PrayerIcon,
} from '../Icons';
import CommunicationPage from './Communication';

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
    id: 'welcome',
    path: '/welcome',
    page: <WelcomePage />,
    requiresAuth: false,
  },
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
    id: 'communication',
    path: '/communication',
    name: 'Communication',
    icon: EmailIcon,
    page: <CommunicationPage />,
    dividerBefore: true,
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

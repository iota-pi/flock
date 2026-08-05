import { create } from 'zustand'
import { persist } from 'zustand/middleware'

import { createAuthSlice, AuthSlice } from './slices/authSlice'
import { createUiSlice, UiSlice } from './slices/uiSlice'
import { createDataSlice, DataSlice } from './slices/dataSlice'
import { createNavigationSlice, NavigationSlice } from './slices/navigationSlice'
import { createPrayerFlowSlice, PrayerFlowSlice } from './slices/prayerFlowSlice'
import { createSyncSlice, SyncSlice } from './slices/syncSlice'
import { createToastSlice, ToastSlice } from './slices/toastSlice'

export type AppStore = AuthSlice &
  UiSlice &
  DataSlice &
  NavigationSlice &
  PrayerFlowSlice &
  SyncSlice &
  ToastSlice

export const useAppStore = create<AppStore>()(
  persist(
    (...a) => ({
      ...createAuthSlice(...a),
      ...createUiSlice(...a),
      ...createDataSlice(...a),
      ...createNavigationSlice(...a),
      ...createPrayerFlowSlice(...a),
      ...createSyncSlice(...a),
      ...createToastSlice(...a),
    }),
    {
      name: 'flock-ui-storage',
      partialize: state => ({
        darkMode: state.darkMode,
      }),
    }
  )
)

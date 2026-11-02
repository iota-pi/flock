import { create } from 'zustand'
import { persist } from 'zustand/middleware'

import { createAuthSlice, type AuthSlice } from './slices/authSlice'
import { createUiSlice, type UiSlice } from './slices/uiSlice'
import { createDataSlice, type DataSlice } from './slices/dataSlice'
import { createNavigationSlice, type NavigationSlice } from './slices/navigationSlice'
import { createPrayerFlowSlice, type PrayerFlowSlice } from './slices/prayerFlowSlice'
import { createSyncSlice, type SyncSlice } from './slices/syncSlice'
import { createToastSlice, type ToastSlice } from './slices/toastSlice'

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

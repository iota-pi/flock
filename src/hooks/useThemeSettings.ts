import { useCallback } from 'react'
import { getNextDarkMode } from '../themeUtils'
import { useAppStore } from '../state/store'

type UseThemeSettingsResult = {
  actions: {
    handleToggleDarkMode: () => void
  }
  values: {
    darkMode: boolean | null
  }
}

export default function useThemeSettings(): UseThemeSettingsResult {
  const darkMode = useAppStore(state => state.darkMode)
  const setUi = useAppStore(state => state.setUi)

  const handleToggleDarkMode = useCallback(() => {
    setUi({
      darkMode: (() => {
        const next = getNextDarkMode(darkMode)
        return next
      })(),
    })
  }, [darkMode, setUi])

  return {
    actions: {
      handleToggleDarkMode,
    },
    values: {
      darkMode,
    },
  }
}
import { useCallback } from 'react'
import { getNextDarkMode } from '../themeUtils'
import { useUiStore } from '../state/uiStore'

type UseThemeSettingsResult = {
  actions: {
    handleToggleDarkMode: () => void
  }
  values: {
    darkMode: boolean | null
  }
}

export default function useThemeSettings(): UseThemeSettingsResult {
  const darkMode = useUiStore(state => state.darkMode)
  const setUi = useUiStore(state => state.setUi)

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
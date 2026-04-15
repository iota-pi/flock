import { useCallback } from 'react'
import { useSearchParams } from 'react-router'

export function useDialogState(dialogId: string, paramName = 'dialog') {
  const [searchParams, setSearchParams] = useSearchParams()
  const isOpen = searchParams.get(paramName) === dialogId
  const searchParamMatches = searchParams.get(paramName) === dialogId

  const openDialog = useCallback(() => {
    if (searchParamMatches) {
      return
    }

    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      next.set(paramName, dialogId)
      return next
    })
  }, [dialogId, paramName, searchParamMatches, setSearchParams])

  const closeDialog = useCallback(() => {
    if (!searchParamMatches) {
      return
    }

    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      next.delete(paramName)
      return next
    })
  }, [dialogId, paramName, searchParamMatches, setSearchParams])

  const toggleDialog = useCallback(() => {
    if (searchParamMatches) {
      closeDialog()
      return
    }

    openDialog()
  }, [closeDialog, dialogId, openDialog, paramName, searchParamMatches])

  return {
    isOpen,
    openDialog,
    closeDialog,
    toggleDialog,
  }
}

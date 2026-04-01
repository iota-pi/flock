import { useCallback } from 'react'
import { useSearchParams } from 'react-router'

export function useDialogState(dialogId: string, paramName = 'dialog') {
  const [searchParams, setSearchParams] = useSearchParams()
  const isOpen = searchParams.get(paramName) === dialogId

  const openDialog = useCallback(() => {
    if (searchParams.get(paramName) === dialogId) {
      return
    }

    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      next.set(paramName, dialogId)
      return next
    })
  }, [dialogId, paramName, searchParams, setSearchParams])

  const closeDialog = useCallback(() => {
    if (searchParams.get(paramName) !== dialogId) {
      return
    }

    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      next.delete(paramName)
      return next
    })
  }, [dialogId, paramName, searchParams, setSearchParams])

  const toggleDialog = useCallback(() => {
    if (searchParams.get(paramName) === dialogId) {
      closeDialog()
      return
    }

    openDialog()
  }, [closeDialog, dialogId, openDialog, paramName, searchParams])

  return {
    isOpen,
    openDialog,
    closeDialog,
    toggleDialog,
  }
}

import { useCallback } from 'react'
import { useSearchParams } from 'react-router'

export function useDialogState(dialogId: string, paramName = 'dialog') {
  const [searchParams, setSearchParams] = useSearchParams()
  const isOpen = searchParams.get(paramName) === dialogId

  const openDialog = useCallback(() => {
    if (isOpen) {
      return
    }

    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      next.set(paramName, dialogId)
      return next
    })
  }, [dialogId, paramName, isOpen, setSearchParams])

  const closeDialog = useCallback(() => {
    if (!isOpen) {
      return
    }

    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      next.delete(paramName)
      return next
    })
  }, [paramName, isOpen, setSearchParams])

  const toggleDialog = useCallback(() => {
    if (isOpen) {
      closeDialog()
      return
    }

    openDialog()
  }, [closeDialog, openDialog, isOpen])

  return {
    isOpen,
    openDialog,
    closeDialog,
    toggleDialog,
  }
}

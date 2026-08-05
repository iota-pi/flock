import type { StateCreator } from 'zustand'
import type { AlertColor } from '@mui/material/Alert'
import type { AppStore } from '../store'

export interface BaseToastMessage {
  severity?: AlertColor
  message: string
}

type ToastMessage = Required<BaseToastMessage>

export interface ToastSlice {
  message: ToastMessage | null
  setMessage: (payload: BaseToastMessage) => void
  clearMessage: () => void
}

export const createToastSlice: StateCreator<
  AppStore,
  [],
  [],
  ToastSlice
> = set => ({
  message: null,
  setMessage: payload => {
    set(() => ({
      message: {
        severity: payload.severity || 'success',
        message: payload.message,
      },
    }))
  },
  clearMessage: () => {
    set(() => ({ message: null }))
  },
})

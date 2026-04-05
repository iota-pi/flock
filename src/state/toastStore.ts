import { create } from 'zustand'
import type { AlertColor } from '@mui/material'

export interface BaseToastMessage {
  severity?: AlertColor
  message: string
}

export type ToastMessage = Required<BaseToastMessage>

export interface ToastStore {
  message: ToastMessage | null
  setMessage: (payload: BaseToastMessage) => void
  clearMessage: () => void
}

export const useToastStore = create<ToastStore>(set => ({
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
}))

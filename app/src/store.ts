import { TypedUseSelectorHook, useDispatch, useSelector } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'

import account from './state/account'
import items from './state/items'
import messages from './state/messages'
import ui from './state/ui'

const store = configureStore({
  reducer: {
    account,
    items,
    messages,
    ui,
  },
})

export default store
export type AppDispatch = typeof store.dispatch
export type RootState = ReturnType<typeof store.getState>
export const useAppDispatch = () => useDispatch<AppDispatch>()
export const useAppSelector: TypedUseSelectorHook<RootState> = useSelector

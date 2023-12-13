import { TypedUseSelectorHook, useDispatch, useSelector } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import type { RootState } from './state';

import account from './state/account';
import items from './state/items';
import { vaultReducer } from './state/vault';
import messages from './state/koinonia';
import { uiReducer } from './state/ui';

const store = configureStore({
  reducer: {
    account,
    items,
    messages,
    vault: vaultReducer,
    ui: uiReducer,
  },
});

export default store;
export type AppDispatch = typeof store.dispatch;
export const useAppDispatch = () => useDispatch<AppDispatch>();
export const useAppSelector: TypedUseSelectorHook<RootState> = useSelector;

import { combineReducers } from 'redux';
import { accountReducer, AccountState, metadataReducer, SetAccountAction } from './account';
import { itemMapReducer, ItemsAction, itemsReducer, ItemsState, noteToItemMapReducer } from './items';
import { KoinoniaState, messagesReducer } from './koinonia';
import { UIAction, uiReducer, UIState } from './ui';
import { SetVaultAction, vaultReducer, VaultState } from './vault';

export interface RootState extends AccountState, ItemsState, VaultState, UIState, KoinoniaState {}

export const rootReducer = combineReducers<RootState>({
  account: accountReducer,
  items: itemsReducer,
  itemMap: itemMapReducer,
  messages: messagesReducer,
  metadata: metadataReducer,
  noteToItemMap: noteToItemMapReducer,
  vault: vaultReducer,
  ui: uiReducer,
});

export type AllActions = (
  SetAccountAction |
  ItemsAction |
  SetVaultAction |
  UIAction
);

import { combineReducers } from 'redux';
import { accountReducer, AccountState, metadataReducer, SetAccountAction } from './account';
import { itemsReducer, ItemsState, noteToItemMapReducer, SetItemsAction } from './items';
import { UIAction, uiReducer, UIState } from './ui';
import { SetVaultAction, vaultReducer, VaultState } from './vault';

export interface RootState extends AccountState, ItemsState, VaultState, UIState {}

export const rootReducer = combineReducers<RootState>({
  account: accountReducer,
  items: itemsReducer,
  metadata: metadataReducer,
  noteToItemMap: noteToItemMapReducer,
  vault: vaultReducer,
  ui: uiReducer,
});

export type AllActions = (
  SetAccountAction |
  SetItemsAction |
  SetVaultAction |
  UIAction
);

import { combineReducers } from 'redux';
import { accountReducer, AccountState, SetAccountAction } from './account';
import { itemsReducer, ItemsState, noteToItemMapReducer, SetItemsAction } from './items';
import { SetVaultAction, vaultReducer, VaultState } from './vault';

export interface RootState extends AccountState, ItemsState, VaultState {}

export const rootReducer = combineReducers<RootState>({
  account: accountReducer,
  items: itemsReducer,
  noteToItemMap: noteToItemMapReducer,
  vault: vaultReducer,
});

export type AllActions = (
  SetAccountAction |
  SetItemsAction |
  SetVaultAction
);

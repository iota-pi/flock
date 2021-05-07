import { combineReducers } from 'redux';
import { accountReducer, AccountState, SetAccountAction } from './account';
import { itemsReducer, ItemsState, SetItemsAction } from './items';
import { SetVaultAction, vaultReducer, VaultState } from './vault';

export interface RootState extends AccountState, ItemsState, VaultState {}

export const rootReducer = combineReducers<RootState>({
  account: accountReducer,
  items: itemsReducer,
  vault: vaultReducer,
});

export type AllActions = (
  SetAccountAction |
  SetItemsAction |
  SetVaultAction
);

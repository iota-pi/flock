import { combineReducers } from 'redux';
import { accountReducer, AccountState, SetAccountAction } from './account';
import { itemsReducer, ItemsState, SetItemsAction } from './items';

export interface RootState extends AccountState, ItemsState {}

export const rootReducer = combineReducers<RootState>({
  account: accountReducer,
  items: itemsReducer,
});

export type AllActions = (
  SetAccountAction |
  SetItemsAction
);

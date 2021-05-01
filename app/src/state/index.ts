import { combineReducers } from 'redux';
import { accountReducer, AccountState, SetAccountAction } from './account';

export interface RootState extends AccountState {}

export const rootReducer = combineReducers<RootState>({
  account: accountReducer,
});

export type AllActions = (
  SetAccountAction
);

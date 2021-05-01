import { Action } from 'redux';
import { AllActions } from '.';

export type AccountId = string | null;
export const initialAccount: AccountId = null;

export interface AccountState {
  account: AccountId,
}

export const SET_ACCOUNT = 'SET_ACCOUNT';

export interface SetAccountAction extends Action, AccountState {
  type: typeof SET_ACCOUNT,
}

export function setAccount(account: string): SetAccountAction {
  return {
    type: SET_ACCOUNT,
    account,
  };
}

export function accountReducer(
  state: AccountId | undefined,
  action: SetAccountAction | AllActions,
): AccountId {
  if (action.type === SET_ACCOUNT) {
    return action.account;
  }

  return state === undefined ? initialAccount : state;
}

import { Action } from 'redux';
import { AllActions } from '.';

export type AccountId = string;
export type AccountMetadata = Record<string, any>;
export const initialAccount: AccountId = '';
export const initialMetadata: AccountMetadata = {};

export interface BaseAccountState {
  account?: AccountId,
  metadata?: AccountMetadata,
}
export type AccountState = Required<BaseAccountState>;

export const SET_ACCOUNT = 'SET_ACCOUNT';

export interface SetAccountAction extends Action, BaseAccountState {
  type: typeof SET_ACCOUNT,
}

export function setAccount({ account, metadata }: BaseAccountState): SetAccountAction {
  return {
    type: SET_ACCOUNT,
    account,
    metadata,
  };
}

export function accountReducer(
  state: AccountId | undefined,
  action: SetAccountAction | AllActions,
): AccountId {
  if (action.type === SET_ACCOUNT) {
    if (action.account) {
      return action.account;
    }
  }

  return state === undefined ? initialAccount : state;
}

export function metadataReducer(
  state: AccountMetadata = initialMetadata,
  action: SetAccountAction | AllActions,
): AccountMetadata {
  if (action.type === SET_ACCOUNT) {
    if (action.metadata) {
      return action.metadata;
    }
  }

  return state;
}

export const DEFAULT_MATURITY: string[] = [
  'Non-Christian',
  'Young Christian',
  'Mature Christian',
];

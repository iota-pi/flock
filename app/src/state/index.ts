import type { AccountState, SetAccountAction } from './account';
import type { ItemsAction, ItemsState } from './items';
import type { KoinoniaState } from './koinonia';
import type { UIAction, UIState } from './ui';
import type { SetVaultAction, VaultState } from './vault';

export interface RootState extends AccountState, ItemsState, VaultState, UIState, KoinoniaState {}

export type AllActions = (
  SetAccountAction |
  ItemsAction |
  SetVaultAction |
  UIAction
);

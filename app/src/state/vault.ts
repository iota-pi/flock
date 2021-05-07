import { Action } from 'redux';
import { AllActions } from '.';
import Vault from '../crypto/Vault';

export interface VaultState {
  vault: Vault | null,
}

export const SET_VAULT = 'SET_VAULT';

export interface SetVaultAction extends Action, VaultState {
  type: typeof SET_VAULT,
}

export function setVault(vault: Vault): SetVaultAction {
  return {
    type: SET_VAULT,
    vault,
  };
}

export function vaultReducer(
  state: Vault | null = null,
  action: SetVaultAction | AllActions,
): Vault | null {
  if (action.type === SET_VAULT) {
    return action.vault;
  }

  return state;
}

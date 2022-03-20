import { Action } from 'redux';
import { AllActions } from '.';
import Vault, { VaultImportExportData } from '../api/Vault';
import { AppDispatch } from '../store';

export interface VaultState {
  vault: Vault | null,
}

export const SET_VAULT = 'SET_VAULT';

export interface SetVaultAction extends Action, VaultState {
  type: typeof SET_VAULT,
}

const VAULT_STORAGE_KEY = 'FlockVaultData';
export async function loadVault(dispatch: AppDispatch): Promise<Vault | null> {
  const jsonData = localStorage.getItem(VAULT_STORAGE_KEY);
  if (jsonData) {
    const data: VaultImportExportData = JSON.parse(jsonData);
    const vault = await Vault.import(data, dispatch);
    dispatch(setVault(vault, false));
    return vault;
  }
  return null;
}

export function setVault(vault: Vault, store = true): SetVaultAction {
  if (store) {
    vault.export().then(data => {
      localStorage.setItem(VAULT_STORAGE_KEY, JSON.stringify(data));
    });
  }
  return {
    type: SET_VAULT,
    vault,
  };
}

export function clearVault(): SetVaultAction {
  localStorage.removeItem(VAULT_STORAGE_KEY);
  return {
    type: SET_VAULT,
    vault: null,
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

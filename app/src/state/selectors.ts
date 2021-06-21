import { useCallback } from 'react';
import { useAppDispatch, useAppSelector } from '../store';
import { updateMetadata } from './account';
import { Item } from './items';


export function useItems<T extends Item>(itemType: T['type']): T[];
export function useItems(): Item[];
export function useItems<T extends Item>(itemType?: T['type']): T[] {
  return useAppSelector(
    state => (
      itemType
        ? state.items.filter(i => i.type === itemType)
        : state.items
    ) as T[],
  );
}
export const useNoteMap = () => useAppSelector(state => state.noteToItemMap);

export const useVault = () => useAppSelector(state => state.vault);

export function useMetadata<T = any>(
  key: string,
  defaultValue: T,
): [T, (value: T) => Promise<boolean | undefined>];
export function useMetadata<T = any>(
  key: string,
): [T | undefined, (value: T) => Promise<boolean | undefined>];
export function useMetadata<T = any>(
  key: string,
  defaultValue?: T,
): [T, (value: T) => Promise<boolean | undefined>] {
  const account = useAppSelector(state => state.account);
  const metadata = useAppSelector(state => state.metadata);
  const dispatch = useAppDispatch();
  const vault = useVault();

  const value = metadata[key] === undefined ? defaultValue : metadata[key];
  const setValue = useCallback(
    async (newValue: T) => {
      const newMetadata = { ...metadata, [key]: newValue };
      await updateMetadata({
        account,
        dispatch,
        metadata: newMetadata,
        vault,
      });
      return false;
    },
    [account, dispatch, key, metadata, vault],
  );
  return [value, setValue];
}
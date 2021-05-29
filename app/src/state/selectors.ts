import { useAppSelector } from '../store';
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

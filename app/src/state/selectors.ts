import { useAppSelector } from '../store';
import { Item } from './items';

export function useItems<T extends Item>(itemType: T['type']): T[] {
  return useAppSelector(state => state.items.filter(i => i.type === itemType)) as T[];
}

export const useVault = () => useAppSelector(state => state.vault);

import { Dispatch, SetStateAction, useCallback, useMemo, useRef } from 'react';
import { useAppDispatch, useAppSelector } from '../store';
import { getTags, Item, ItemId, ItemOrNote } from './items';
import { setUiState, UiOptions } from './ui';


export function useItems<T extends Item>(itemType: T['type']): T[];
export function useItems(): Item[];
export function useItems<T extends Item>(itemType?: T['type']): T[] {
  const items = useAppSelector(state => state.items);
  return useMemo(
    () => (
      itemType
        ? items.filter(i => i.type === itemType)
        : items
    ) as T[],
    [items, itemType],
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
  const metadata = useAppSelector(state => state.metadata);
  const vault = useVault();

  const value = metadata[key] === undefined ? defaultValue : metadata[key];
  const setValue = useCallback(
    async (newValue: T) => {
      const newMetadata = { ...metadata, [key]: newValue };
      await vault?.setMetadata(newMetadata);
      return false;
    },
    [key, metadata, vault],
  );
  return [value, setValue];
}

export const useTags = () => {
  const items = useItems();
  const tags = useMemo(
    () => getTags(items),
    [items],
  );
  return tags;
};

export const useDrawerItems = () => {
  const drawers = useAppSelector(state => state.ui.drawers);
  return useMemo(
    () => {
      const items = drawers.map(drawer => drawer.item);
      return items.filter(
        (item): item is Exclude<typeof item, undefined> => item !== undefined,
      );
    },
    [drawers],
  );
};

export const useDrawerItemIds = (): ItemId[] => {
  const result = useRef<ItemId[]>([]);
  const items = useDrawerItems();
  const ids = items.map(item => item.id);
  if (ids.join('~') !== result.current.join('~')) {
    result.current = ids;
  }
  return result.current;
};

export const useIsActive = () => {
  const ids = useDrawerItemIds();
  return useCallback(
    (note: ItemOrNote) => ids.includes(note.id),
    [ids],
  );
};

export const useOptions = () => useAppSelector(state => state.ui.options);
export function useOption<T extends keyof UiOptions>(
  optionKey: T,
): [UiOptions[T], Dispatch<SetStateAction<UiOptions[T]>>] {
  const option = useOptions()[optionKey];

  const dispatch = useAppDispatch();
  const setOption: Dispatch<SetStateAction<UiOptions[T]>> = useCallback(
    valueOrFunction => {
      let newValue: UiOptions[T];
      if (typeof valueOrFunction === 'function') {
        newValue = valueOrFunction(option);
      } else {
        newValue = valueOrFunction;
      }
      dispatch(setUiState({
        options: { [optionKey]: newValue },
      }));
    },
    [dispatch, option, optionKey],
  );
  return [option, setOption];
}

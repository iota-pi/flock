import memoize from 'proxy-memoize';
import { Dispatch, SetStateAction, useCallback, useMemo } from 'react';
import { useAppDispatch, useAppSelector } from '../store';
import { DEFAULT_CRITERIA } from '../utils/customSort';
import { DEFAULT_MATURITY } from './account';
import { getTags, Item, ItemId, MessageItem } from './items';
import { getMessageItem } from './koinonia';
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

export const useItemMap = () => useAppSelector(state => state.itemMap);
export const useNoteMap = () => useAppSelector(state => state.noteToItemMap);
export const useItemOrNote = (id: ItemId) => useAppSelector(
  memoize(
    state => {
      const item: Item | undefined = state.itemMap[id];
      if (item) {
        return item;
      }
      const noteItem: Item | undefined = state.itemMap[state.noteToItemMap[id]];
      if (noteItem) {
        return noteItem.notes.find(note => note.id === id);
      }

      return undefined;
    },
  ),
);

export const useMessageItem = (id: string): MessageItem | undefined => useAppSelector(
  memoize(state => {
    const message = state.messages.find(m => m.message === id);
    if (message) {
      return getMessageItem(message);
    }
    return undefined;
  }),
);

export function useItemsById() {
  const itemMap = useItemMap();
  return useCallback(
    <T extends Item>(ids: ItemId[]) => (
      ids.map(id => itemMap[id] as T).filter(item => item !== undefined)
    ),
    [itemMap],
  );
}

export const useVault = () => useAppSelector(state => state.vault);
export const useLoggedIn = () => useAppSelector(state => !!state.vault);

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

export const useMaturity = () => useMetadata('maturity', DEFAULT_MATURITY);
export const useSortCriteria = () => useMetadata('sortCriteria', DEFAULT_CRITERIA);

export const useTags = () => {
  const items = useItems();
  const tags = useMemo(
    () => getTags(items),
    [items],
  );
  return tags;
};

export const useIsActive = () => {
  const drawers = useAppSelector(state => state.ui.drawers);
  return useCallback(
    (itemId: ItemId, report?: boolean) => (
      drawers.findIndex(drawer => (
        drawer.open
        && drawer.item === itemId
        && (report === undefined || !report === !drawer.report)
      )) > -1
    ),
    [drawers],
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

import { memoize } from 'proxy-memoize';
import { Dispatch, SetStateAction, useCallback, useMemo } from 'react';
import { useAppDispatch, useAppSelector } from '../store';
import { DEFAULT_CRITERIA } from '../utils/customSort';
import { AccountMetadata as Metadata, MetadataKey } from './account';
import { getTags, Item, ItemId, MessageItem } from './items';
import { getMessageItem } from './koinonia';
import { setUiState, UiOptions } from './ui';

// TODO: where should this live?
export const DEFAULT_MATURITY: string[] = [
  'Non-Christian',
  'Young Christian',
  'Mature Christian',
];

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

export const useMessageItem = (id: string): MessageItem | undefined => {
  const message = useAppSelector(memoize(
    state => state.messages.find(m => m.message === id),
  ));
  return useMemo(
    () => (message ? getMessageItem(message) : undefined),
    [message],
  );
};

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

export function useMetadata<K extends MetadataKey>(
  key: K,
  defaultValue: Metadata[K],
): [
  Exclude<Metadata[K], undefined>,
  (value: Metadata[K] | ((prev: Metadata[K]) => Metadata[K])) => Promise<void>,
];
export function useMetadata<K extends MetadataKey>(
  key: K,
): [Metadata[K], (value: Metadata[K] | ((prev: Metadata[K]) => Metadata[K])) => Promise<void>];
export function useMetadata<K extends MetadataKey>(
  key: K,
  defaultValue?: Metadata[K],
): [Metadata[K], (value: Metadata[K] | ((prev: Metadata[K]) => Metadata[K])) => Promise<void>] {
  const metadata = useAppSelector(state => state.metadata);
  const vault = useVault();

  const value = metadata[key] === undefined ? defaultValue : metadata[key];
  const setValue = useCallback(
    async (newValueOrFunc: Metadata[K] | ((prev: Metadata[K]) => Metadata[K])) => {
      const newValue = typeof newValueOrFunc === 'function' ? newValueOrFunc(value) : newValueOrFunc;
      const newMetadata = { ...metadata, [key]: newValue };
      await vault?.setMetadata(newMetadata);
    },
    [key, metadata, value, vault],
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

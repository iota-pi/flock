import {
  useCallback,
  useMemo,
  useRef,
} from 'react';
import { GlobalHotKeys, KeyMap } from 'react-hotkeys';
import {
  Item,
  MessageItem,
} from '../../state/items';
import { replaceActive, setTagFilter } from '../../state/ui';
import { useAppDispatch } from '../../store';
import { SearchIcon } from '../Icons';
import Search from '../Search';

export interface Props {
  label: string,
  noItemsText?: string,
  onSelect?: (item?: Item | MessageItem | string) => void,
}

function EverythingSearch({
  label,
  noItemsText,
  onSelect,
}: Props) {
  const dispatch = useAppDispatch();
  const searchInput = useRef<HTMLInputElement>(null);
  const focusSearch = useCallback(
    () => {
      if (searchInput.current) {
        searchInput.current.focus();
      }
    },
    [searchInput],
  );
  const keyMap: KeyMap = useMemo(
    () => ({
      SEARCH: { sequence: '/', action: 'keyup' },
    }),
    [],
  );
  const handlers = useMemo(
    () => ({
      SEARCH: focusSearch,
    }),
    [focusSearch],
  );

  const handleCreate = useCallback(
    (newItem: Item) => {
      dispatch(replaceActive({ newItem }));
    },
    [dispatch],
  );
  const handleSelect: typeof onSelect = useCallback(
    item => {
      if (typeof item === 'string') {
        dispatch(setTagFilter(item));
      } else {
        dispatch(replaceActive({ item: item.id }));
      }
      if (onSelect) {
        onSelect(item);
      }
    },
    [dispatch, onSelect],
  );

  return (
    <>
      <GlobalHotKeys keyMap={keyMap} handlers={handlers} />
      <Search
        forceDarkTheme
        inputIcon={SearchIcon}
        inputRef={searchInput}
        placeholder={label}
        onCreate={handleCreate}
        onSelect={handleSelect}
        noItemsText={noItemsText}
        searchDescription
        searchSummary
        searchNotes
        showIcons
      />
    </>
  );
}

export default EverythingSearch;

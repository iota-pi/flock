import {
  useCallback,
  useRef,
} from 'react';
import { GlobalHotKeys, KeyMap } from 'react-hotkeys';
import {
  Item,
  MessageItem,
} from '../../state/items';
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
  const searchInput = useRef<HTMLInputElement>(null);
  const focusSearch = useCallback(
    () => {
      if (searchInput.current) {
        searchInput.current.focus();
      }
    },
    [searchInput],
  );
  const keyMap: KeyMap = {
    SEARCH: { sequence: '/', action: 'keyup' },
  };
  const handlers = {
    SEARCH: focusSearch,
  };

  return (
    <>
      <GlobalHotKeys keyMap={keyMap} handlers={handlers} />
      <Search
        disableClearable
        forceDarkTheme
        inputIcon={SearchIcon}
        inputRef={searchInput}
        placeholder={label}
        onSelect={onSelect}
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

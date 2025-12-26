import {
  useCallback,
  useRef,
} from 'react'
import { useHotkeys } from 'react-hotkeys-hook'
import { Item } from '../../state/items'
import { replaceActive } from '../../state/ui'
import { useAppDispatch } from '../../store'
import { SearchIcon } from '../Icons'
import Search from '../Search'

export interface Props {
  label: string,
  noItemsText?: string,
  onSelect?: (item?: Item | string) => void,
}

function EverythingSearch({
  label,
  noItemsText,
  onSelect,
}: Props) {
  const dispatch = useAppDispatch()
  const searchInput = useRef<HTMLInputElement>(null)
  const focusSearch = useCallback(
    () => {
      if (searchInput.current) {
        searchInput.current.focus()
      }
    },
    [searchInput],
  )
  useHotkeys('/', focusSearch, { keyup: true, keydown: false })

  const handleCreate = useCallback(
    (newItem: Item) => {
      dispatch(replaceActive({ newItem }))
    },
    [dispatch],
  )
  const handleSelect = useCallback(
    (item: Item) => {
      if (item) {
        dispatch(replaceActive({ item: item.id }))
      }
      if (onSelect) {
        onSelect(item)
      }
    },
    [dispatch, onSelect],
  )

  return (
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
      showIcons
    />
  )
}

export default EverythingSearch

import {
  useCallback,
  useRef,
} from 'react'
import { useHotkeys } from 'react-hotkeys-hook'
import { Item, StandardItem } from '../../state/items'
import { SearchIcon } from '../Icons'
import Search from '../Search'
import { useNavigationStore } from '../../state/navigationStore'
import { createItem } from '../../features/items/mutations/itemMutations'
import { ERROR_ITEM_TYPE } from 'src/shared/itemTypes'

interface Props {
  label: string,
  noItemsText?: string,
  onSelect?: (item?: Item | string) => void,
}

function EverythingSearch({
  label,
  noItemsText,
  onSelect,
}: Props) {
  const replaceActive = useNavigationStore(state => state.replaceActive)
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
    (itemToCreate: Item) => {
      if (itemToCreate.type === ERROR_ITEM_TYPE) {
        return
      }

      const {
        id: _id,
        type,
        ...overrides
      } = itemToCreate

      void createItem(type, overrides).then(createdItem => {
        replaceActive({ item: createdItem.id, initialItem: createdItem as StandardItem })
      }).catch(error => {
        console.error(error)
      })
    },
    [replaceActive],
  )
  const handleSelect = useCallback(
    (item: Item) => {
      if (item) {
        replaceActive({ item: item.id })
      }
      if (onSelect) {
        onSelect(item)
      }
    },
    [onSelect, replaceActive],
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

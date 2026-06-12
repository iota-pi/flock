import {
  useCallback,
  useRef,
} from 'react'
import { useHotkeys } from 'react-hotkeys-hook'
import { Item } from '../../state/items'
import { SearchIcon } from '../Icons'
import Search from '../Search'
import { useAppStore } from '../../state/store'
import { createItem } from '../../features/items/mutations/itemMutations'
import { ERROR_ITEM_TYPE } from 'src/shared/schemas/items'


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
  const setDrawer = useAppStore(state => state.setDrawer)
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
        setDrawer({ item: createdItem.id })
      }).catch(error => {
        console.error(error)
      })
    },
    [setDrawer],
  )
  const handleSelect = useCallback(
    (item: Item) => {
      if (item) {
        setDrawer({ item: item.id })
      }
      if (onSelect) {
        onSelect(item)
      }
    },
    [onSelect, setDrawer],
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

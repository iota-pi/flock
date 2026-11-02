import {
  type ChangeEvent,
  type Ref,
  useCallback,
  useMemo,
  useRef,
  useState,
} from 'react'
import TextField from '@mui/material/TextField'
import { ThemeProvider } from '@mui/material/styles'
import Autocomplete, { autocompleteClasses } from '@mui/material/Autocomplete'
import Chip from '@mui/material/Chip'
import InputAdornment from '@mui/material/InputAdornment'
import Paper, { type PaperProps } from '@mui/material/Paper'
import type {
  AutocompleteChangeReason,
  FilterOptionsState,
} from '@mui/material/useAutocomplete'
import { type KeyOption, matchSorter } from 'match-sorter'
import { upperFirst } from 'lodash-es'

import {
  getBlankItem,
  getItemName,
  type Item,
} from '../state/items'
import { getIcon, type MuiIconType } from './Icons'
import { useItemsByIds, useMetadata, useSearchItems } from '../state/selectors'
import { useAppStore } from '../state/store'
import getTheme from '../theme'
import {
  ALL_SEARCHABLE_TYPES,
  type AnySearchable,
  type AnySearchableData,
  type AnySearchableType,
} from './search/types'
import {
  getName,
  sortSearchables,
} from './search/utils'
import ListBoxComponent, { type SearchListVirtualizerApi } from './search/ListBox'
import { ERROR_ITEM_TYPE, ITEM_TYPES } from 'src/shared/schemas/items'
import type { ItemId } from '@vault/shared'
import { createLogger } from '@vault/client'

const log = createLogger('Search')


function ThemedPaper({ children, ...props }: PaperProps) {
  const darkMode = useAppStore(state => state.darkMode)
  const theme = useMemo(() => getTheme(darkMode), [darkMode])

  return (
    <ThemeProvider theme={theme}>
      <Paper {...props}>
        {children}
      </Paper>
    </ThemeProvider>
  )
}

interface Props<T> {
  dataCy?: string,
  forceDarkTheme?: boolean,
  includeArchived?: boolean,
  inputIcon?: MuiIconType,
  inputRef?: Ref<HTMLInputElement>,
  label?: string,
  placeholder?: string,
  noItemsText?: string,
  onClear?: () => void,
  onCreate?: (item: Item) => void,
  onRemove?: (item: T) => void,
  onSelect?: (item: T) => void,
  selectedItemIds?: ItemId[],
  searchDescription?: boolean,
  searchSummary?: boolean,
  showDescriptions?: boolean,
  showGroupMemberCounts?: boolean,
  showIcons?: boolean,
  showSelectedChips?: boolean,
  showSelectedOptions?: boolean,
  showOptionCheckboxes?: boolean,
  types?: Readonly<Partial<Record<AnySearchableType, boolean>>>,
}

const DARK_THEME = getTheme(true)
const EMPTY_ITEM_IDS: ItemId[] = []

function toSearchable(item: Item): AnySearchable {
  return {
    data: item,
    id: item.id,
    name: getItemName(item),
    type: item.type,
  }
}

function Search<T extends AnySearchableData = AnySearchableData>({
  dataCy,
  forceDarkTheme = false,
  includeArchived = false,
  inputIcon: InputIcon,
  inputRef,
  label,
  placeholder,
  noItemsText = 'No items found',
  onClear,
  onCreate,
  onRemove,
  onSelect,
  selectedItemIds = EMPTY_ITEM_IDS,
  searchDescription = false,
  searchSummary = false,
  showDescriptions = true,
  showGroupMemberCounts = true,
  showIcons = true,
  showSelectedChips = false,
  showSelectedOptions = false,
  showOptionCheckboxes = false,
  types = ALL_SEARCHABLE_TYPES,
}: Props<T>) {
  const selectedItems = useItemsByIds(selectedItemIds)
  const [isOpen, setIsOpen] = useState(false)
  const handleOpen = useCallback(() => setIsOpen(true), [])
  const handleClose = useCallback(() => setIsOpen(false), [])

  const [defaultFrequencies] = useMetadata('defaultPrayerFrequency', {})
  const items = useSearchItems({
    isOpen,
    includeArchived,
    selectedItemIds,
    showSelectedOptions,
    types,
  })

  const selectedSearchables = useMemo(() => selectedItems.map(toSearchable), [selectedItems])
  const options = useMemo(() => items.map(toSearchable), [items])

  const matchSorterKeys = useMemo(
    () => {
      const result: KeyOption<AnySearchable>[] = ['name']
      const threshold = matchSorter.rankings.CONTAINS
      if (searchDescription) {
        result.push({ key: 'data.description', threshold })
      }
      if (searchSummary) {
        result.push({ key: 'data.notes.*.text', threshold })
      }
      return result
    },
    [searchDescription, searchSummary],
  )

  const filterFunc = useCallback(
    (allOptions: AnySearchable[], state: FilterOptionsState<AnySearchable>) => {
      const query = state.inputValue.trim()
      if (!query) {
        return allOptions
      }

      const filtered = matchSorter(
        allOptions,
        query,
        {
          baseSort: (a, b) => sortSearchables(a.item, b.item),
          keys: matchSorterKeys,
          threshold: matchSorter.rankings.MATCHES,
        },
      )

      if (onCreate) {
        filtered.push(...ITEM_TYPES.map((type, index): AnySearchable => ({
          create: true,
          default: { type, name: upperFirst(query) },
          dividerBefore: index === 0,
          id: `add-${type}`,
          type,
        })))
      }

      return filtered
    },
    [matchSorterKeys, onCreate],
  )

  const handleChange = useCallback(
    (
      event: ChangeEvent<EventTarget>,
      value: AnySearchable[],
      reason: AutocompleteChangeReason,
    ) => {
      if (reason === 'selectOption') {
        const option = value[value.length - 1]
        if (option.create) {
          if (onCreate && option.type !== ERROR_ITEM_TYPE) {
            onCreate({
              ...getBlankItem(option.type),
              ...option.default,
              prayerFrequency: defaultFrequencies?.[option.type] ?? 'none',
            } as Item)
          }
        } else {
          const data = option.data as T
          if (selectedItemIds.includes(data.id)) {
            onRemove?.(data)
          } else if (onSelect) {
            onSelect(data)
          }
        }
      }
      if (onRemove && reason === 'removeOption') {
        const removed = selectedSearchables.find(item => !value.some(i => i.id === item.id))
        if (removed) {
          onRemove(removed.data as T)
        } else {
          log.warn('Could not find the removed option among the selected items')
        }
      }
      if (onClear && reason === 'clear') {
        onClear()
      }
    },
    [defaultFrequencies, onClear, onCreate, onRemove, onSelect, selectedItemIds, selectedSearchables],
  )

  const theme = useMemo(
    () => (forceDarkTheme ? DARK_THEME : {}),
    [forceDarkTheme],
  )
  const internalListRef = useRef<SearchListVirtualizerApi | null>(null)
  const optionIndexMapRef = useRef<Map<string, number>>(new Map())

  const handleItemsBuilt = useCallback(
    (optionIndexMap: Map<string, number>) => {
      optionIndexMapRef.current = optionIndexMap
    },
    [],
  )
  const handleHighlightChange = useCallback(
    (_event: React.SyntheticEvent, option: AnySearchable | null) => {
      if (!option || !internalListRef.current) {
        return
      }

      const index = optionIndexMapRef.current.get(option.id)
      if (index !== undefined) {
        internalListRef.current.scrollToIndex(index)
      }
    },
    [internalListRef],
  )

  return (
    <ThemeProvider theme={theme}>
      <Autocomplete
        autoHighlight
        disableClearable={!onClear}
        disableListWrap
        filterOptions={filterFunc}
        filterSelectedOptions={!showSelectedOptions}
        disableCloseOnSelect={showOptionCheckboxes}
        getOptionLabel={option => getName(option)}
        isOptionEqualToValue={(a, b) => a.id === b.id}
        slots={{
          paper: ThemedPaper,
        }}
        slotProps={{
          listbox: {
            component: ListBoxComponent,
            internalListRef,
            onItemsBuilt: handleItemsBuilt,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any,
          popper: {
            sx: {
              [`& .${autocompleteClasses.listbox}`]: {
                boxSizing: 'border-box',
                '& ul': {
                  padding: 0,
                  margin: 0,
                },
              },
            },
          },
        }}
        multiple
        noOptionsText={noItemsText}
        onOpen={handleOpen}
        onClose={handleClose}
        onChange={handleChange}
        onHighlightChange={handleHighlightChange}
        options={options}
        renderInput={({ slotProps, ...params }) => {
          if (InputIcon && slotProps?.input) {
            slotProps.input.startAdornment = (
              <InputAdornment position="start">
                <InputIcon />
              </InputAdornment>
            )
          }
          if (dataCy && slotProps?.htmlInput) {
            slotProps.htmlInput['data-cy'] = dataCy
          }
          return (
            <TextField
              {...params}
              aria-label={label || placeholder || 'Search'}
              inputRef={inputRef}
              slotProps={slotProps}
              label={label}
              placeholder={placeholder}
              variant="outlined"
            />
          )
        }}
        renderOption={
          (props, option, { selected }) => ([
            props,
            option,
            { showDescriptions, showGroupMemberCounts, showIcons, showCheckboxes: showOptionCheckboxes, selected },
          ]) as React.ReactNode
        }
        renderValue={(selectedOptions, getItemProps) => {
          if (!showSelectedChips) {
            return null
          }

          return selectedOptions.map((option, index) => {
            const { key, ...props } = getItemProps({ index })
            return (
              <Chip
                {...props}
                key={key}
                label={getName(option)}
                icon={getIcon(option.type)}
              />
            )
          })
        }}
        value={selectedSearchables}
      />
    </ThemeProvider>
  )
}

export default Search

import {
  ChangeEvent,
  Ref,
  useCallback,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  Autocomplete,
  autocompleteClasses,
  Chip,
  InputAdornment,
  Paper,
  PaperProps,
  Popper,
  styled,
  TextField,
  ThemeProvider,
} from '@mui/material'
import {
  AutocompleteChangeReason,
  FilterOptionsState,
} from '@mui/material/useAutocomplete'
import { KeyOption, matchSorter } from 'match-sorter'
import {
  getBlankItem,
  getItemName,
  Item,
} from '../state/items'
import { getIcon, MuiIconType } from './Icons'
import { useItemsByIds, useSearchItems } from '../state/selectors'
import { useUiStore } from '../state/uiStore'
import getTheme from '../theme'
import {
  ALL_SEARCHABLE_TYPES,
  AnySearchable,
  AnySearchableData,
  AnySearchableType,
} from './search/types'
import {
  getName,
  sortSearchables,
} from './search/utils'
import ListBoxComponent, { SearchListVirtualizerApi } from './search/ListBox'
import { upperFirst } from 'lodash-es'
import { ERROR_ITEM_TYPE, ItemId } from 'src/shared/itemTypes'

const StyledPopper = styled(Popper)({
  [`& .${autocompleteClasses.listbox}`]: {
    boxSizing: 'border-box',
    '& ul': {
      padding: 0,
      margin: 0,
    },
  },
})

function ThemedPaper({ children, ...props }: PaperProps) {
  const darkMode = useUiStore(state => state.darkMode)
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
  autoFocus?: boolean,
  dataCy?: string,
  forceDarkTheme?: boolean,
  includeArchived?: boolean,
  inputIcon?: MuiIconType,
  inputRef?: Ref<HTMLInputElement>,
  label?: string,
  placeholder?: string,
  maxChips?: number,
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
  keepPopperOpenOnSelect?: boolean,
  types?: Readonly<Partial<Record<AnySearchableType, boolean>>>,
}

const DARK_THEME = getTheme(true)
const EMPTY_ITEM_IDS: string[] = []

function Search<T extends AnySearchableData = AnySearchableData>({
  autoFocus,
  dataCy,
  forceDarkTheme = false,
  includeArchived = false,
  inputIcon: InputIcon,
  inputRef,
  label,
  placeholder,
  maxChips,
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

  const {
    defaultFrequencies,
    items,
  } = useSearchItems({
    isOpen,
    includeArchived,
    selectedItemIds,
    showSelectedOptions,
    types,
  })

  const selectedSearchables = useMemo(
    () => selectedItems.map(
      (item): AnySearchable => ({
        data: item,
        id: item.id,
        name: getItemName(item),
        type: item.type,
      }),
    ),
    [selectedItems],
  )

  const options = useMemo<AnySearchable[]>(
    () => {
      const results: AnySearchable[] = []
      results.push(
        ...items.map((item): AnySearchable => ({
          type: item.type,
          id: item.id,
          data: item,
          name: getItemName(item),
        })),
      )
      return results
    },
    [items],
  )

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
      const filtered = (
        state.inputValue.trim()
          ? matchSorter(
            allOptions,
            state.inputValue.trim(),
            {
              baseSort: (a, b) => sortSearchables(a.item, b.item),
              keys: matchSorterKeys,
              threshold: matchSorter.rankings.MATCHES,
            },
          )
          : allOptions
      )

      if (onCreate && state.inputValue.trim()) {
        filtered.push(
          {
            create: true,
            default: {
              type: 'person',
              name: upperFirst(state.inputValue.trim()),
            },
            dividerBefore: true,
            id: 'add-person',
            type: 'person',
          },
          {
            create: true,
            default: {
              type: 'group',
              name: upperFirst(state.inputValue.trim()),
            },
            id: 'add-group',
            type: 'group',
          },
          {
            create: true,
            default: {
              type: 'topic',
              name: upperFirst(state.inputValue.trim()),
            },
            id: 'add-topic',
            type: 'topic',
          },
        )
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
        const deletedItems = selectedSearchables.filter(item => !value.find(i => i.id === item.id))
        if (deletedItems.length && deletedItems[0].data) {
          onRemove(deletedItems[0].data as T)
        } else {
          console.warn(`No data found for deleted item ${deletedItems[0]}`)
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
          popper: StyledPopper,
        }}
        slotProps={{
          listbox: {
            component: ListBoxComponent,
            internalListRef,
            onItemsBuilt: handleItemsBuilt,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any,
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
              autoFocus={autoFocus}
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

          const visibleOptions = maxChips
            ? selectedOptions.slice(0, maxChips)
            : selectedOptions

          const chips = visibleOptions.map((option, index) => (
            // eslint-disable-next-line react/jsx-key
            <Chip
              {...getItemProps({ index })}
              label={getName(option)}
              icon={getIcon(option.type)}
            />
          ))

          if (maxChips && selectedOptions.length > maxChips) {
            chips.push(
              <Chip
                key="more"
                label={`+${selectedOptions.length - maxChips}`}
              />
            )
          }

          return chips
        }}
        value={selectedSearchables}
      />
    </ThemeProvider>
  )
}

export default Search

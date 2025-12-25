import {
  ChangeEvent,
  Ref,
  useCallback,
  useMemo,
} from 'react'
import {
  Autocomplete,
  autocompleteClasses,
  Box,
  Chip,
  InputAdornment,
  Paper,
  PaperProps,
  Popper,
  styled,
  TextField,
  ThemeProvider,
  Typography,
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
import InlineText from './InlineText'
import { useItems, useMetadata, useSortCriteria } from '../state/selectors'
import { useAppSelector } from '../store'
import getTheme from '../theme'
import { sortItems } from '../utils/customSort'
import { capitalise } from '../utils'
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
import ListBoxComponent from './search/ListBox'
import { AutocompleteOption, OptionIconHolder, OptionName } from './search/Option'

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
  const darkMode = useAppSelector(state => state.ui.darkMode)
  const theme = useMemo(() => getTheme(darkMode), [darkMode])

  return (
    <ThemeProvider theme={theme}>
      <Paper {...props}>
        {children}
      </Paper>
    </ThemeProvider>
  )
}

export interface Props<T> {
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
  selectedItems?: T[],
  searchDescription?: boolean,
  searchSummary?: boolean,
  showDescriptions?: boolean,
  showGroupMemberCounts?: boolean,
  showIcons?: boolean,
  showSelectedChips?: boolean,
  showSelectedOptions?: boolean,
  showOptionCheckboxes?: boolean,
  /** Keep the popper open after selecting an option */
  keepPopperOpenOnSelect?: boolean,
  types?: Readonly<Partial<Record<AnySearchableType, boolean>>>,
}

const DARK_THEME = getTheme(true)

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
  selectedItems = [],
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
  const items = useItems()
  const [sortCriteria] = useSortCriteria()
  const [defaultFrequencies] = useMetadata('defaultPrayerFrequency', {})

  const selectedIds = useMemo(
    () => new Set(selectedItems.map(s => (typeof s === 'string' ? s : s.id))),
    [selectedItems],
  )

  const selectedSearchables: AnySearchable[] = useMemo(
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

  const filteredItems = useMemo(
    () => sortItems(
      items.filter(item => (
        types[item.type]
        && (includeArchived || !item.archived)
        && (showSelectedOptions || !selectedIds.has(item.id))
      )),
      sortCriteria,
    ),
    [includeArchived, items, selectedIds, showSelectedOptions, sortCriteria, types],
  )

  const options = useMemo<AnySearchable[]>(
    () => {
      const results: AnySearchable[] = []
      results.push(
        ...filteredItems.map((item): AnySearchable => ({
          type: item.type,
          id: item.id,
          data: item,
          name: getItemName(item),
        })),
      )
      return results
    },
    [filteredItems, types],
  )

  const matchSorterKeys = useMemo(
    () => {
      const result: KeyOption<AnySearchable>[] = ['name']
      const threshold = matchSorter.rankings.CONTAINS
      if (searchDescription) {
        result.push({ key: 'data.description', threshold })
      }
      if (searchSummary) {
        result.push({ key: 'data.summary', threshold })
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
              name: capitalise(state.inputValue.trim()),
            },
            dividerBefore: true,
            id: 'add-person',
            type: 'person',
          },
          {
            create: true,
            default: {
              type: 'group',
              name: capitalise(state.inputValue.trim()),
            },
            id: 'add-group',
            type: 'group',
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
          if (onCreate) {
            onCreate({
              ...getBlankItem(option.type),
              ...option.default,
              prayerFrequency: defaultFrequencies?.[option.type] ?? 'none',
            } as Item)
          }
        } else {
          const data = option.data as T
          if (selectedIds.has(data.id)) {
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
    [defaultFrequencies, onClear, onCreate, onRemove, onSelect, selectedSearchables],
  )

  const theme = useMemo(
    () => (forceDarkTheme ? DARK_THEME : {}),
    [forceDarkTheme],
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
          listbox: ListBoxComponent,
          paper: ThemedPaper,
          popper: StyledPopper,
        }}
        multiple
        noOptionsText={noItemsText}
        onChange={handleChange}
        options={options}
        renderInput={({ InputProps, InputLabelProps, inputProps, ...params }) => {
          // TODO: Once MUI updates AutocompleteRenderInputParams to include slotProps,
          // migrate to destructuring slotProps from params and using those instead of
          // the deprecated InputProps and InputLabelProps.
          // See: https://github.com/mui/material-ui/issues/45414 for status
          return (
            <TextField
              {...params}
              autoFocus={autoFocus}
              inputRef={inputRef}
              slotProps={{
                input: {
                  ...InputProps,
                  startAdornment: (
                    <>
                      {InputIcon && (
                        <InputAdornment position="start">
                          <InputIcon />
                        </InputAdornment>
                      )}

                      {InputProps.startAdornment}
                    </>
                  ),
                },
                inputLabel: InputLabelProps,
                htmlInput: {
                  ...inputProps,
                  'data-cy': dataCy,
                }
              }}
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
        renderTags={(selectedOptions, getTagProps) => (
          showSelectedChips && (
            maxChips
              ? selectedOptions.slice(0, maxChips)
              : selectedOptions
          ).map((option, index) => (
            <Chip
              {...getTagProps({ index })}
              label={getName(option)}
              icon={getIcon(option.type)}
            />
          )).concat(
            maxChips && selectedOptions.length > maxChips
              ? [
                <Chip
                  key="more"
                  label={`+${selectedOptions.length - maxChips}`}
                />
              ]
              : []
          )
        )}
        value={selectedSearchables}
      />
    </ThemeProvider>
  )
}

export default Search

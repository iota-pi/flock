import {
  ChangeEvent,
  ForwardedRef,
  forwardRef,
  HTMLAttributes,
  PropsWithChildren,
  Ref,
  useCallback,
  useMemo,
} from 'react'
import { List, RowComponentProps } from 'react-window'
import {
  Autocomplete,
  autocompleteClasses,
  Box,
  Checkbox,
  Chip,
  Divider,
  InputAdornment,
  Paper,
  PaperProps,
  Popper,
  styled,
  TextField,
  Theme,
  ThemeProvider,
  Typography,
} from '@mui/material'
import {
  AutocompleteChangeReason,
  FilterOptionsState,
} from '@mui/material/useAutocomplete'
import { KeyOption, matchSorter } from 'match-sorter'
import {
  compareItems,
  getBlankItem,
  getItemName,
  getItemTypeLabel,
  isItem,
  Item,
} from '../state/items'
import InlineText from './InlineText'
import { getIcon, MuiIconType } from './Icons'
import { useItems, useMetadata, useSortCriteria } from '../state/selectors'
import { useAppSelector } from '../store'
import getTheme from '../theme'
import { sortItems } from '../utils/customSort'
import { capitalise } from '../utils'

const LISTBOX_PADDING = 8

const OptionHolder = styled('li')({
  display: 'block',
  padding: 0,
})
const AutocompleteOption = styled('div')(({ theme }) => ({
  alignItems: 'center',
  display: 'flex',
  minWidth: 0,
  padding: theme.spacing(1.75, 0),
}))
const OptionIconHolder = styled('div')(({ theme }) => ({
  display: 'flex',
  alignItems: 'center',
  paddingRight: theme.spacing(2),
}))
const OptionName = styled(InlineText)({
  flexGrow: 1,
  minWidth: 0,
})

interface SearchableItem<T extends Item = Item> {
  create?: false,
  data: T,
  dividerBefore?: boolean,
  name: string,
  id: string,
  type: T['type'],
}
interface SearchableAddItem<T extends Item = Item> {
  create: true,
  data?: undefined,
  default: Partial<T> & Pick<T, 'type'>,
  dividerBefore?: boolean,
  id: string,
  type: T['type'],
}
export type AnySearchable = (
  SearchableItem
  | SearchableAddItem
)
export type AnySearchableData = Exclude<AnySearchable['data'], undefined>
export type AnySearchableType = AnySearchable['type']
export const ALL_SEARCHABLE_TYPES: Readonly<Record<AnySearchableType, boolean>> = {
  group: true,
  person: true,
}
export const SEARCHABLE_BASE_SORT_ORDER: AnySearchableType[] = (
  ['person', 'group']
)

export function getSearchableDataId(s: AnySearchableData): string {
  return typeof s === 'string' ? s : s.id
}

function isSearchableStandardItem(s: AnySearchable): s is SearchableItem {
  return s.type === 'person' || s.type === 'group'
}

function sortSearchables(a: AnySearchable, b: AnySearchable): number {
  const typeIndexA = SEARCHABLE_BASE_SORT_ORDER.indexOf(a.type)
  const typeIndexB = SEARCHABLE_BASE_SORT_ORDER.indexOf(b.type)
  if (typeIndexA - typeIndexB) {
    return typeIndexA - typeIndexB
  }
  if (isSearchableStandardItem(a) && isSearchableStandardItem(b)) {
    return compareItems(a.data, b.data)
  }
  return +(a.id > b.id) - +(a.id < b.id)
}

function getName(option: AnySearchable) {
  if (option.create) {
    return getItemName(option.default)
  }
  return getItemName(option.data)
}

function OptionComponent({
  option,
  showDescription,
  showGroupMemberCount,
  showIcon,
  showCheckbox,
  selected,
}: {
  option: AnySearchable,
  showDescription: boolean,
  showGroupMemberCount: boolean,
  showIcon: boolean,
  showCheckbox: boolean,
  selected: boolean,
}) {
  const icon = getIcon(option.type)
  const name = getName(option)
  const item = isSearchableStandardItem(option) ? option.data : undefined

  const groupMembersText = useMemo(
    () => {
      if (item && item.type === 'group') {
        const count = item.members.length
        const s = count !== 1 ? 's' : ''
        return ` (${count} member${s})`
      }
      return ''
    },
    [item],
  )
  const clippedDescription = useMemo(
    () => {
      if (item && isItem(item)) {
        const base = item.description
        const clipped = base.slice(0, 100)
        if (clipped.length < base.length) {
          const clippedToWord = clipped.slice(0, clipped.lastIndexOf(' '))
          return `${clippedToWord}…`
        }
        return base
      }
      return null
    },
    [item],
  )

  const getFontSize = useCallback(
    (theme: Theme) => theme.typography.caption.fontSize,
    [],
  )

  return (
    <>
      {option.dividerBefore && <Divider />}

      <AutocompleteOption>
        {showCheckbox && (
          <OptionIconHolder>
            <Checkbox size="small" checked={!!selected} tabIndex={-1} disableRipple />
          </OptionIconHolder>
        )}
        {showIcon && (
          <OptionIconHolder>
            {icon}
          </OptionIconHolder>
        )}

        {option.create ? (
          <div>
            <span>Add {getItemTypeLabel(option.type).toLowerCase()} </span>
            <Typography fontWeight={500}>
              {name}
            </Typography>
          </div>
        ) : (
          <Box minWidth={0}>
            <Typography display="flex" alignItems="center">
              <OptionName noWrap>
                {name}
              </OptionName>

              <InlineText
                color="text.secondary"
                fontWeight={300}
                whiteSpace="pre"
              >
                {showGroupMemberCount && option.type === 'group' ? groupMembersText : ''}
              </InlineText>
            </Typography>

            {showDescription && clippedDescription && (
              <InlineText
                color="text.secondary"
                fontSize={getFontSize}
                noWrap
              >
                {clippedDescription}
              </InlineText>
            )}
          </Box>
        )}
      </AutocompleteOption>
    </>
  )
}

interface SearchableRowSettings {
  showDescriptions: boolean,
  showGroupMemberCounts: boolean,
  showIcons: boolean,
  showCheckboxes: boolean,
  selected: boolean,
}
type PropsAndOption = [HTMLAttributes<HTMLLIElement>, AnySearchable, SearchableRowSettings]

interface SearchableRowProps {
  itemData: PropsAndOption[],
}

function SearchableRow(
  props: RowComponentProps<SearchableRowProps>,
) {
  const { itemData, index, style } = props
  const [optionProps, option, settings] = itemData[index]

  return (
    <OptionHolder
      {...optionProps}
      key={option.id}
      style={style}
    >
      <OptionComponent
        option={option}
        showDescription={settings.showDescriptions}
        showGroupMemberCount={settings.showGroupMemberCounts}
        showIcon={settings.showIcons}
        showCheckbox={settings.showCheckboxes}
        selected={settings.selected}
      />
    </OptionHolder>
  )
}

const ListBoxComponent = forwardRef(
  (
    props: PropsWithChildren<HTMLAttributes<HTMLElement>>,
    ref: ForwardedRef<HTMLDivElement>,
  ) => {
    const { children, ...otherProps } = props
    const itemData = children as PropsAndOption[]
    const itemSize = 56

    const itemsHeight = itemSize * Math.min(itemData.length, 6)

    return (
      <div
        ref={ref}
        {...otherProps}
        style={{
          paddingTop: LISTBOX_PADDING,
          paddingBottom: LISTBOX_PADDING,
        }}
      >
        <List<SearchableRowProps>
          rowProps={{ itemData }}
          style={{
            height: itemsHeight,
            width: '100%',
          }}
          rowComponent={SearchableRow}
          rowHeight={itemSize}
          overscanCount={2}
          rowCount={itemData.length}
        />
      </div>
    )
  },
)
ListBoxComponent.displayName = 'ListBoxComponent'

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
        ListboxComponent={ListBoxComponent}
        multiple
        noOptionsText={noItemsText}
        onChange={handleChange}
        options={options}
        PaperComponent={ThemedPaper}
        PopperComponent={StyledPopper}
        renderInput={params => (
          <TextField
            {...params}
            autoFocus={autoFocus}
            inputRef={inputRef}
            InputProps={{
              ...params.InputProps,
              startAdornment: (
                <>
                  {InputIcon && (
                    <InputAdornment position="start">
                      <InputIcon />
                    </InputAdornment>
                  )}

                  {params.InputProps.startAdornment}
                </>
              ),
            }}
            inputProps={{
              ...params.inputProps,
              'data-cy': dataCy,
            }}
            label={label}
            placeholder={placeholder}
            variant="outlined"
          />
        )}
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

import {
  ChangeEvent,
  createContext,
  ForwardedRef,
  forwardRef,
  HTMLAttributes,
  memo,
  PropsWithChildren,
  Ref,
  useCallback,
  useContext,
  useMemo,
} from 'react';
import { ListChildComponentProps, VariableSizeList } from 'react-window';
import {
  Autocomplete,
  autocompleteClasses,
  Chip,
  Divider,
  InputAdornment,
  Paper,
  PaperProps,
  Popper,
  styled,
  TextField,
  ThemeProvider,
} from '@mui/material';
import {
  AutocompleteChangeReason,
  FilterOptionsState,
} from '@mui/material/useAutocomplete';
import makeStyles from '@mui/styles/makeStyles';
import { matchSorter } from 'match-sorter';
import {
  getBlankItem,
  getItemName,
  getItemTypeLabel,
  Item,
  MessageItem,
  splitName,
} from '../state/items';
import { getIcon, SearchIcon } from './Icons';
import { useItems, useMaturity, useSortCriteria, useTags } from '../state/selectors';
import { replaceActive, setTagFilter } from '../state/ui';
import { useAppDispatch, useAppSelector } from '../store';
import getTheme from '../theme';
import { sortItems } from '../utils/customSort';
import { useResetCache } from '../utils/virtualisation';
import { capitalise } from '../utils';
import { getMessageItem } from '../state/koinonia';

const LISTBOX_PADDING = 8;

const useStyles = makeStyles(theme => ({
  optionHolder: {
    display: 'block',
    padding: 0,
  },
  autocompleteOption: {
    display: 'flex',
    alignItems: 'center',
    padding: theme.spacing(1.75, 2),
  },
  optionIcon: {
    display: 'flex',
    alignItems: 'center',
    paddingRight: theme.spacing(2),
  },
  whiteTextField: {
    '& .MuiOutlinedInput-notchedOutline': {
      borderColor: 'rgba(255, 255, 255, 0.45)',
    },
    '& .Mui-focused.MuiInputLabel-root': {
      color: theme.palette.primary.contrastText,
    },
    '& .Mui-focused .MuiOutlinedInput-notchedOutline': {
      borderColor: 'rgba(255, 255, 255, 0.85)',
    },
  },
  emphasis: {
    fontWeight: 500,
  },
}));

interface SearchableItem<T extends Item = Item> {
  create?: false,
  data: T,
  dividerBefore?: boolean,
  name: string,
  id: string,
  type: T['type'],
}
interface SearchableMessage {
  create?: false,
  data: MessageItem,
  dividerBefore?: boolean,
  name: string,
  id: string,
  type: MessageItem['type'],
}
interface SearchableTag {
  create?: false,
  data: string,
  dividerBefore?: boolean,
  name: string,
  id: string,
  type: 'tag',
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
  | SearchableMessage
  | SearchableTag
  | SearchableAddItem
);
export type AnySearchableType = AnySearchable['type'];
export const ALL_SEARCHABLE_TYPES: Record<AnySearchableType, boolean> = {
  general: true,
  group: true,
  message: true,
  person: true,
  tag: true,
};

function getName(option: AnySearchable) {
  if (option.type === 'tag') {
    return option.data;
  }
  if (option.create) {
    return getItemName(option.default);
  }
  return getItemName(option.data);
}

function OptionComponent({
  option,
  showIcons = true,
}: {
  option: AnySearchable,
  showIcons?: boolean,
}) {
  const classes = useStyles();
  const icon = getIcon(option.type);
  const name = getName(option);

  return (
    <>
      {option.dividerBefore && <Divider />}

      <div className={classes.autocompleteOption}>
        {showIcons && (
          <div className={classes.optionIcon}>
            {icon}
          </div>
        )}

        <div>
          {option.create ? (
            <>
              <span>Add {getItemTypeLabel(option.type).toLowerCase()} </span>
              <span className={classes.emphasis}>{name}</span>
            </>
          ) : name}
        </div>
      </div>
    </>
  );
}

interface SearchableRowSettings {
  showIcons?: boolean,
}
type PropsAndOption = [HTMLAttributes<HTMLLIElement>, AnySearchable, SearchableRowSettings];
type PropsAndOptionList = PropsAndOption[];

const SearchableRow = memo((
  props: ListChildComponentProps<PropsAndOptionList>,
) => {
  const classes = useStyles();
  const { data, index, style } = props;
  const [optionProps, option, settings] = data[index];
  const inlineStyle = {
    ...style,
    top: (style.top as number) + LISTBOX_PADDING,
  };

  return (
    <li
      {...optionProps}
      className={`${optionProps.className} ${classes.optionHolder}`}
      key={option.id}
      style={inlineStyle}
    >
      <OptionComponent
        option={option}
        showIcons={settings.showIcons}
      />
    </li>
  );
});
SearchableRow.displayName = 'SearchableRow';

const OuterElementContext = createContext({});

const OuterElementType = forwardRef<HTMLDivElement>((props, ref) => {
  const outerProps = useContext(OuterElementContext);
  return <div ref={ref} {...props} {...outerProps} />;
});
OuterElementType.displayName = 'OuterElementType';

const ListBoxComponent = forwardRef(
  (
    props: PropsWithChildren<HTMLAttributes<HTMLElement>>,
    ref: ForwardedRef<HTMLDivElement>,
  ) => {
    const { children, ...otherProps } = props;
    const itemData = children as PropsAndOptionList;
    const itemSize = 56;

    const gridRef = useResetCache(itemData.length);
    const getHeight = useCallback(
      () => itemSize * Math.min(itemData.length, 6),
      [itemData, itemSize],
    );

    return (
      <div ref={ref}>
        <OuterElementContext.Provider value={otherProps}>
          <VariableSizeList<PropsAndOptionList>
            itemData={itemData}
            height={getHeight() + 2 * LISTBOX_PADDING}
            width="100%"
            ref={gridRef}
            outerElementType={OuterElementType}
            innerElementType="ul"
            itemSize={() => itemSize}
            overscanCount={2}
            itemCount={itemData.length}
          >
            {SearchableRow}
          </VariableSizeList>
        </OuterElementContext.Provider>
      </div>
    );
  },
);
ListBoxComponent.displayName = 'ListBoxComponent';

const StyledPopper = styled(Popper)({
  [`& .${autocompleteClasses.listbox}`]: {
    boxSizing: 'border-box',
    '& ul': {
      padding: 0,
      margin: 0,
    },
  },
});

function ThemedPaper({ children, ...props }: PaperProps) {
  const darkMode = useAppSelector(state => state.ui.darkMode);
  const theme = useMemo(() => getTheme(darkMode), [darkMode]);

  return (
    <ThemeProvider theme={theme}>
      <Paper {...props}>
        {children}
      </Paper>
    </ThemeProvider>
  );
}

export interface Props {
  inputRef?: Ref<HTMLInputElement>,
  label: string,
  noItemsText?: string,
  onSelect?: (item?: Item | MessageItem | string) => void,
  showIcons?: boolean,
  types?: Record<AnySearchableType, boolean | undefined>,
}

function Search({
  inputRef,
  label,
  noItemsText,
  onSelect,
  showIcons,
  types: rawTypes,
}: Props) {
  const classes = useStyles();
  const dispatch = useAppDispatch();
  const items = useItems();
  const [sortCriteria] = useSortCriteria();
  const [maturity] = useMaturity();
  const messages = useAppSelector(state => state.messages);
  const tags = useTags();
  const types = rawTypes || ALL_SEARCHABLE_TYPES;

  const options = useMemo<AnySearchable[]>(
    () => {
      const results: AnySearchable[] = [];
      const filteredItems = items.filter(item => types[item.type]);
      results.push(
        ...sortItems(filteredItems, sortCriteria, maturity).map((item): AnySearchable => ({
          type: item.type,
          id: item.id,
          data: item,
          name: getItemName(item),
        })),
      );
      if (types.message) {
        results.push(
          ...messages.map((message): AnySearchable => ({
            type: 'message',
            id: message.message,
            data: getMessageItem(message),
            name: message.name,
          })),
        );
      }
      if (types.tag) {
        results.push(
          ...tags.map((tag): AnySearchable => ({
            type: 'tag',
            id: tag,
            data: tag,
            name: tag,
          })),
        );
      }
      return results;
    },
    [items, maturity, messages, sortCriteria, tags, types],
  );

  const filterFunc = useCallback(
    (allOptions: AnySearchable[], state: FilterOptionsState<AnySearchable>) => {
      const filtered = matchSorter(
        allOptions,
        state.inputValue.trim(),
        {
          keys: [
            'name',
            { key: 'data.description', threshold: matchSorter.rankings.CONTAINS },
            { key: 'data.summary', threshold: matchSorter.rankings.CONTAINS },
            { key: 'data.notes.*.content', threshold: matchSorter.rankings.CONTAINS },
          ],
          threshold: matchSorter.rankings.MATCHES,
        },
      );

      if (state.inputValue.trim()) {
        filtered.push(
          {
            create: true,
            default: {
              type: 'person',
              ...splitName(state.inputValue.trim(), true),
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
          {
            create: true,
            default: {
              type: 'general',
              name: capitalise(state.inputValue.trim()),
            },
            id: 'add-general',
            type: 'general',
          },
        );
      }

      return filtered;
    },
    [],
  );

  const handleChange = useCallback(
    (event: ChangeEvent<{}>, value: AnySearchable[], reason: AutocompleteChangeReason) => {
      if (reason === 'selectOption') {
        const option = value[value.length - 1];
        if (option.create) {
          dispatch(replaceActive({
            newItem: {
              ...getBlankItem(option.type),
              ...option.default,
            } as Item,
          }));
        } else {
          const data = value[value.length - 1].data;
          if (onSelect) {
            onSelect(data);
          }
          if (typeof data === 'string') {
            dispatch(setTagFilter(data));
          } else {
            dispatch(replaceActive({ item: data?.id }));
          }
        }
      }
      if (reason === 'removeOption' || reason === 'clear') {
        if (onSelect) {
          onSelect(undefined);
        }
      }
    },
    [dispatch, onSelect],
  );

  return (
    <>
      <Autocomplete
        autoHighlight
        disableClearable
        disableListWrap
        filterOptions={filterFunc}
        getOptionLabel={option => getName(option)}
        ListboxComponent={ListBoxComponent}
        isOptionEqualToValue={(a, b) => a.id === b.id}
        multiple
        noOptionsText={noItemsText || 'No items found'}
        onChange={handleChange}
        options={options}
        PaperComponent={ThemedPaper}
        PopperComponent={StyledPopper}
        renderInput={params => (
          <TextField
            {...params}
            placeholder={label}
            variant="outlined"
            className={classes.whiteTextField}
            inputRef={inputRef}
            InputProps={{
              ...params.InputProps,
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon />
                </InputAdornment>
              ),
            }}
          />
        )}
        renderOption={(props, option): PropsAndOption => [props, option, { showIcons }]}
        renderTags={selectedOptions => (
          selectedOptions.map(option => (
            <Chip
              key={option.id}
              label={getName(option)}
              icon={getIcon(option.type)}
            />
          ))
        )}
        value={[]}
      />
    </>
  );
}

export default Search;

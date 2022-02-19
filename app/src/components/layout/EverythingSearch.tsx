import {
  ChangeEvent,
  createContext,
  ForwardedRef,
  forwardRef,
  HTMLAttributes,
  memo,
  PropsWithChildren,
  useCallback,
  useContext,
  useMemo,
  useRef,
} from 'react';
import { GlobalHotKeys, KeyMap } from 'react-hotkeys';
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
  splitName,
} from '../../state/items';
import { getIcon, SearchIcon } from '../Icons';
import { useItems, useMaturity, useSortCriteria, useTags } from '../../state/selectors';
import { replaceActive, setTagFilter } from '../../state/ui';
import { useAppDispatch, useAppSelector } from '../../store';
import getTheme from '../../theme';
import { sortItems } from '../../utils/customSort';
import { useResetCache } from '../../utils/virtualisation';
import { capitalise } from '../../utils';

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
  | SearchableTag
  | SearchableAddItem
);

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

type PropsAndOptionList = [HTMLAttributes<HTMLLIElement>, AnySearchable][];

const SearchableRow = memo((
  props: ListChildComponentProps<PropsAndOptionList>,
) => {
  const classes = useStyles();
  const { data, index, style } = props;
  const [optionProps, option] = data[index];
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
      <OptionComponent option={option} />
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
  label: string,
  noItemsText?: string,
  onSelect?: (item?: Item | string) => void,
}

function EverythingSearch({
  label,
  noItemsText,
  onSelect,
}: Props) {
  const classes = useStyles();
  const dispatch = useAppDispatch();
  const items = useItems();
  const [sortCriteria] = useSortCriteria();
  const [maturity] = useMaturity();
  const tags = useTags();

  const options = useMemo<AnySearchable[]>(
    () => [
      ...sortItems(items, sortCriteria, maturity).map(item => ({
        type: item.type,
        id: item.id,
        data: item,
        name: getItemName(item),
      } as AnySearchable)),
      ...tags.map(tag => ({
        type: 'tag',
        id: tag,
        data: tag,
        name: tag,
      } as AnySearchable)),
    ],
    [items, maturity, sortCriteria, tags],
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
              ...splitName(state.inputValue.trim()),
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

  const searchInput = useRef<HTMLInputElement>();
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
            inputRef={searchInput}
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
        renderOption={(props, option) => [props, option]}
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

export default EverythingSearch;

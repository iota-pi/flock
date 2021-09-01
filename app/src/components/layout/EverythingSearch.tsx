import {
  ChangeEvent,
  useCallback,
  useMemo,
  useRef,
} from 'react';
import { GlobalHotKeys, KeyMap } from 'react-hotkeys';
import { useHistory } from 'react-router-dom';
import { Chip, Divider, InputAdornment, makeStyles, TextField } from '@material-ui/core';
import { Autocomplete, AutocompleteChangeReason, createFilterOptions, FilterOptionsState } from '@material-ui/lab';
import {
  compareItems,
  getBlankItem,
  getItemName,
  getItemTypeLabel,
  Item,
} from '../../state/items';
import { getIcon, SearchIcon } from '../Icons';
import { useItems, useTags } from '../../state/selectors';
import { getTagPage } from '../pages';
import { replaceActive } from '../../state/ui';
import { useAppDispatch } from '../../store';

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
    '& .Mui-focused.MuiInputLabel-root': {
      color: theme.palette.text.primary,
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
  id: string,
  type: T['type'],
}
interface SearchableTag {
  create?: false,
  data: string,
  dividerBefore?: boolean,
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

const baseFilterFunc = createFilterOptions<AnySearchable>({ trim: true });

function getName(option: AnySearchable) {
  if (option.type === 'tag') {
    return option.data;
  }
  if (option.create) {
    return getItemName(option.default);
  }
  return getItemName(option.data);
}

function capitalise(name: string) {
  return name.charAt(0).toLocaleUpperCase() + name.substr(1);
}

function OptionComponent({
  option,
  showIcons,
}: {
  option: AnySearchable,
  showIcons: boolean,
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

export interface Props {
  label: string,
  noItemsText?: string,
  onSelect?: (item?: Item | string) => void,
  showIcons?: boolean,
}

function EverythingSearch({
  label,
  noItemsText,
  onSelect,
  showIcons = true,
}: Props) {
  const classes = useStyles();
  const dispatch = useAppDispatch();
  const history = useHistory();
  const items = useItems();
  const tags = useTags();

  const options = useMemo<AnySearchable[]>(
    () => (
      [
        ...items.sort(compareItems).map(item => ({
          type: item.type,
          id: item.id,
          data: item,
        } as AnySearchable)),
        ...tags.map(tag => ({
          type: 'tag',
          id: tag,
          data: tag,
        } as AnySearchable)),
      ]
    ),
    [items, tags],
  );

  const filterFunc = useCallback(
    (allOptions: AnySearchable[], state: FilterOptionsState<AnySearchable>) => {
      const filtered = baseFilterFunc(allOptions, state);

      if (state.inputValue.trim()) {
        filtered.push(
          {
            create: true,
            default: {
              type: 'person',
              firstName: capitalise(state.inputValue.trim().split(/\s+/, 2)[0]),
              lastName: capitalise(state.inputValue.trim().split(/\s+/, 2)[1] || ''),
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
      if (reason === 'select-option') {
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
            history.push(getTagPage(data));
          } else {
            dispatch(replaceActive({ item: data?.id }));
          }
        }
      }
      if (reason === 'remove-option' || reason === 'clear') {
        if (onSelect) {
          onSelect(undefined);
        }
      }
    },
    [dispatch, history, onSelect],
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
        classes={{
          option: classes.optionHolder,
        }}
        disableClearable
        filterOptions={filterFunc}
        getOptionLabel={option => getName(option)}
        getOptionSelected={(a, b) => a.id === b.id}
        multiple
        noOptionsText={noItemsText || 'No items found'}
        onChange={handleChange}
        options={options}
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
        renderOption={option => (
          <OptionComponent
            option={option}
            showIcons={showIcons}
          />
        )}
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

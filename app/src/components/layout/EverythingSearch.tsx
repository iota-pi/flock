import React, {
  ChangeEvent,
  useCallback,
  useMemo,
  useRef,
} from 'react';
import { GlobalHotKeys, KeyMap } from 'react-hotkeys';
import { Chip, InputAdornment, makeStyles, TextField } from '@material-ui/core';
import { Autocomplete, AutocompleteChangeReason, createFilterOptions } from '@material-ui/lab';
import {
  compareItems,
  getItemName,
  Item,
} from '../../state/items';
import { getIcon, SearchIcon } from '../Icons';
import { useItems, useTags } from '../../state/selectors';

const useStyles = makeStyles(theme => ({
  autocompleteOption: {
    display: 'flex',
    alignItems: 'center',
    paddingTop: theme.spacing(1),
    paddingBottom: theme.spacing(1),
  },
  optionIcon: {
    display: 'flex',
    alignItems: 'center',
    paddingRight: theme.spacing(2),
  },
  notchedOutline: {},
  focused: {},
  label: {
    '&$focused': {
    },
  },
  inputRoot: {
    '&$focused $notchedOutline': {
      borderColor: 'rgba(255, 255, 255, 0.85)',
    },
  },
  whiteTextField: {
    '& .Mui-focused.MuiInputLabel-root': {
      color: theme.palette.text.primary,
    },
    '& .Mui-focused .MuiOutlinedInput-notchedOutline': {
      borderColor: 'rgba(255, 255, 255, 0.85)',
    },
  },
}));

interface SearchableItem<T extends Item = Item> {
  type: T['type'],
  id: string,
  data: T,
}
interface SearchableTag {
  type: 'tag',
  id: string,
  data: string,
}
export type AnySearchable = SearchableItem | SearchableTag;

const filterFunc = createFilterOptions<AnySearchable>({ trim: true });

function getName(item: AnySearchable) {
  return item.type === 'tag' ? item.data : getItemName(item.data);
}

function OptionComponent({
  item,
  showIcons,
}: {
  item: AnySearchable,
  showIcons: boolean,
}) {
  const classes = useStyles();
  const icon = getIcon(item.type);
  const name = getName(item);

  return (
    <div className={classes.autocompleteOption}>
      {showIcons && (
        <div className={classes.optionIcon}>
          {icon}
        </div>
      )}

      <div>
        {name}
      </div>
    </div>
  );
}

export interface Props {
  label: string,
  noItemsText?: string,
  onSelect: (item?: Item | string) => void,
  showIcons?: boolean,
}

function EverythingSearch({
  label,
  noItemsText,
  onSelect,
  showIcons = true,
}: Props) {
  const classes = useStyles();
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

  const handleChange = useCallback(
    (event: ChangeEvent<{}>, value: AnySearchable[], reason: AutocompleteChangeReason) => {
      if (reason === 'select-option') {
        onSelect(value[value.length - 1].data);
      }
      if (reason === 'remove-option' || reason === 'clear') {
        onSelect(undefined);
      }
    },
    [onSelect],
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
        renderOption={item => (
          <OptionComponent
            item={item}
            showIcons={showIcons}
          />
        )}
        renderTags={tagItems => (
          tagItems.map(item => (
            <Chip
              key={item.id}
              label={getName(item)}
              icon={getIcon(item.type)}
            />
          ))
        )}
        value={[]}
      />
    </>
  );
}

export default EverythingSearch;

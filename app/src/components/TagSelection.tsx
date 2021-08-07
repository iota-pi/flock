import React, {
  ChangeEvent,
  useCallback,
} from 'react';
import { Chip, InputAdornment, makeStyles, TextField } from '@material-ui/core';
import { Autocomplete, AutocompleteChangeReason, createFilterOptions, FilterOptionsState } from '@material-ui/lab';
import { useTags } from '../state/selectors';
import { MuiIconType } from './Icons';

const useStyles = makeStyles(theme => ({
  subtle: {
    color: theme.palette.text.secondary,
  },
  tagChip: {
    marginRight: theme.spacing(1),
    marginTop: theme.spacing(0.25),
    marginBottom: theme.spacing(0.25),
  },
}));

export interface Props {
  canAddNew?: boolean,
  icon?: MuiIconType,
  label?: string,
  onChange: (tags: string[]) => void,
  selectedTags: string[],
}

const baseFilterFunc = createFilterOptions<string>({ trim: true });

function TagSelection({
  canAddNew = true,
  icon: Icon,
  label,
  onChange,
  selectedTags,
}: Props) {
  const classes = useStyles();
  const tags = useTags();
  const allTags = [...tags, ...selectedTags.filter(tag => !tags.includes(tag))];

  const handleChange = useCallback(
    (event: ChangeEvent<{}>, value: string[], reason: AutocompleteChangeReason) => {
      if (reason !== 'blur') {
        onChange(value);
      }
    },
    [onChange],
  );
  const handleDelete = useCallback(
    (deletedTag: string) => () => {
      onChange(selectedTags.filter(t => t !== deletedTag));
    },
    [onChange, selectedTags],
  );

  const filterFunc = useCallback(
    (options: string[], state: FilterOptionsState<string>) => {
      const filtered = baseFilterFunc(options, state);

      if (canAddNew && state.inputValue !== '' && !filtered.includes(state.inputValue)) {
        filtered.push(state.inputValue);
      }

      return filtered;
    },
    [canAddNew],
  );

  return (
    <Autocomplete
      autoHighlight
      clearOnBlur
      filterOptions={filterFunc}
      getOptionLabel={tag => tag}
      handleHomeEndKeys
      multiple
      noOptionsText="No tag found"
      onChange={handleChange}
      options={allTags}
      renderInput={params => (
        <TextField
          {...params}
          label={label || 'Tags'}
          variant="outlined"
          InputProps={{
            ...params.InputProps,
            startAdornment: Icon ? (
              <>
                <InputAdornment position="start">
                  <Icon />
                </InputAdornment>

                {params.InputProps.startAdornment}
              </>
            ) : params.InputProps.startAdornment,
          }}
        />
      )}
      renderOption={tag => (
        tags.includes(tag) ? tag : (
          <>
            {tag}
            &nbsp;
            <span className={classes.subtle}>(new tag)</span>
          </>
        )
      )}
      renderTags={tagsToRender => (
        tagsToRender.map(tag => (
          <Chip
            key={tag}
            label={tag}
            onDelete={handleDelete(tag)}
            className={classes.tagChip}
          />
        ))
      )}
      selectOnFocus
      value={selectedTags}
    />
  );
}

export default TagSelection;

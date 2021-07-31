import React, {
  ChangeEvent,
  useCallback,
} from 'react';
import { Chip, InputAdornment, makeStyles, TextField } from '@material-ui/core';
import { Autocomplete, AutocompleteChangeReason, createFilterOptions } from '@material-ui/lab';
import { useTags } from '../state/selectors';
import { MuiIconType } from './Icons';

const useStyles = makeStyles(theme => ({
  subtle: {
    color: theme.palette.text.secondary,
  },
  tagChip: {
    marginRight: theme.spacing(1),
  },
}));

export interface Props {
  canAddNew?: boolean,
  icon?: MuiIconType,
  label?: string,
  onChange: (tags: string[]) => void,
  selectedTags: string[],
}

const filterFunc = createFilterOptions<string>({ trim: true });

function TagSelection({
  canAddNew = true,
  icon: Icon,
  label,
  onChange,
  selectedTags,
}: Props) {
  const classes = useStyles();
  const tags = useTags();

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

  return (
    <Autocomplete
      autoHighlight
      clearOnBlur
      filterOptions={(options, params) => {
        const filtered = filterFunc(options, params);

        if (canAddNew && params.inputValue !== '') {
          filtered.push(params.inputValue);
        }

        return filtered;
      }}
      getOptionLabel={tag => tag}
      handleHomeEndKeys
      multiple
      noOptionsText="No tag found"
      onChange={handleChange}
      options={tags}
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

import {
  ChangeEvent,
  useCallback,
} from 'react';
import {
  Autocomplete,
  AutocompleteRenderInputParams,
  Chip,
  InputAdornment,
  styled,
  TextField,
  TextFieldProps,
  Typography,
} from '@mui/material';
import {
  AutocompleteChangeReason,
  createFilterOptions,
  FilterOptionsState,
} from '@mui/material/useAutocomplete';
import { useTags } from '../state/selectors';
import { MuiIconType } from './Icons';


export interface Props {
  canAddNew?: boolean,
  fullWidth?: boolean,
  icon?: MuiIconType,
  label?: string,
  onChange: (tags: string[]) => void,
  selectedTags: string[],
  single?: boolean,
  variant?: TextFieldProps['variant'],
}

export interface TagChipProps {
  tag: string,
  onDelete: (tag: string) => void,
}

const StyledChip = styled(Chip)(({ theme }) => ({
  marginRight: theme.spacing(1),
  marginTop: theme.spacing(0.25),
  marginBottom: theme.spacing(0.25),
}));

function TagChip({
  tag,
  onDelete,
}: TagChipProps) {
  const handleDelete = useCallback(() => onDelete(tag), [onDelete, tag]);

  return (
    <StyledChip
      label={tag}
      onDelete={handleDelete}
    />
  );
}

const baseFilterFunc = createFilterOptions<string>({ trim: true });

function TagSelection({
  canAddNew = true,
  fullWidth,
  icon: Icon,
  label,
  onChange,
  selectedTags,
  single,
  variant = 'outlined',
}: Props) {
  const tags = useTags();
  const allTags = [...tags, ...selectedTags.filter(tag => !tags.includes(tag))];

  const handleChange = useCallback(
    (
      event: ChangeEvent<EventTarget>,
      value: string | string[] | null,
      reason: AutocompleteChangeReason,
    ) => {
      if (reason !== 'blur') {
        if (typeof value === 'string') {
          onChange([value]);
        } else if (value === null) {
          onChange([]);
        } else {
          onChange(value);
        }
      }
    },
    [onChange],
  );
  const handleDelete = useCallback(
    (deletedTag: string) => {
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
  const getOptionLabel = useCallback((tag: string) => tag, []);
  const renderInput = useCallback(
    (params: AutocompleteRenderInputParams) => (
      <TextField
        {...params}
        data-cy="tag-selection"
        label={label || 'Tags'}
        variant={variant}
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
    ),
    [Icon, label, variant],
  );
  const renderOption = useCallback(
    (props: React.HTMLAttributes<HTMLLIElement>, tag: string) => (
      <li {...props}>
        {tags.includes(tag) ? tag : (
          <>
            {tag}
            &nbsp;
            <Typography color="text.secondary">
              (new tag)
            </Typography>
          </>
        )}
      </li>
    ),
    [tags],
  );
  const renderTags = useCallback(
    (tagsToRender: string[]) => (
      tagsToRender.map(tag => (
        <TagChip
          key={tag}
          tag={tag}
          onDelete={handleDelete}
        />
      ))
    ),
    [handleDelete],
  );

  const value = single ? (selectedTags[0] || null) : selectedTags;

  return (
    <Autocomplete
      autoHighlight
      clearOnBlur
      filterOptions={filterFunc}
      fullWidth={fullWidth}
      getOptionLabel={getOptionLabel}
      handleHomeEndKeys
      multiple={!single}
      noOptionsText="No tag found"
      onChange={handleChange}
      options={allTags}
      renderInput={renderInput}
      renderOption={renderOption}
      renderTags={renderTags}
      selectOnFocus
      value={value}
    />
  );
}

export default TagSelection;

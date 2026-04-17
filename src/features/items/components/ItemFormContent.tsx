import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Grid,
  IconButton,
  InputAdornment,
  TextField,
  Tooltip,
} from '@mui/material'
import {
  DirtyItem,
  getItemName,
  Item,
} from '../../../state/items'
import { zodResolver } from '@hookform/resolvers/zod'
import { Controller, FormProvider, useForm, useWatch } from 'react-hook-form'
import { useItems } from '../../../state/selectors'
import {
  DeleteIcon,
  NotesIcon,
} from '../../../components/Icons'
import ItemFormDuplicateAlertSection from './ItemFormDuplicateAlertSection'
import ItemFormNotesSection from './ItemFormNotesSection'
import ItemFormFrequencySection from './ItemFormFrequencySection'
import ItemFormRelationshipsSection from './ItemFormRelationshipsSection'
import {
  buildItemPatchFromDraftValues,
  cloneItemFormDraftValues,
  getItemFormDefaultValues,
  ItemFormDraftInput,
  ItemFormDraftSchema,
  ItemFormDraftValues,
} from './itemFormValues'

interface ItemFormContentProps {
  item: DirtyItem<Item>,
  handleChange: <T extends Item>(data: Partial<T> | ((prev: Item) => Item)) => void,
  autoFocusName?: boolean,
  fromPrayerPage?: boolean,
  hideHeaderFields?: boolean,
  hideRelationships?: boolean,
}

function ItemFormContent({
  item,
  handleChange,
  autoFocusName = true,
  fromPrayerPage = false,
  hideHeaderFields = false,
  hideRelationships = false,
}: ItemFormContentProps) {
  const allItems = useItems()
  const [defaultValues] = useState<ItemFormDraftValues>(() => getItemFormDefaultValues(item))
  const [showDescription, setShowDescription] = useState(defaultValues.description.length > 0)
  const formMethods = useForm<ItemFormDraftInput, unknown, ItemFormDraftValues>({
    resolver: zodResolver(ItemFormDraftSchema),
    mode: 'onChange',
    defaultValues,
  })
  const {
    control,
    setValue,
    formState: { errors },
  } = formMethods

  const draftValues = useWatch({
    control,
    defaultValue: defaultValues,
  }) as ItemFormDraftValues
  const nameValue = useWatch({
    control,
    name: 'name',
    defaultValue: defaultValues.name,
  }) || ''
  const descriptionValue = useWatch({
    control,
    name: 'description',
    defaultValue: defaultValues.description,
  }) || ''
  const previousDraftRef = useRef<ItemFormDraftValues>(cloneItemFormDraftValues(defaultValues))

  useEffect(
    () => {
      const updates = buildItemPatchFromDraftValues(previousDraftRef.current, draftValues, item.type)

      if (Object.keys(updates).length === 0) {
        return
      }

      previousDraftRef.current = cloneItemFormDraftValues(draftValues)
      handleChange<Item>(updates)
    },
    [draftValues, handleChange, item.type],
  )

  const handleAddDescription = useCallback(() => setShowDescription(true), [])
  const handleRemoveDescription = useCallback(() => {
    setValue('description', '', {
      shouldDirty: true,
      shouldValidate: true,
    })
    setShowDescription(false)
  }, [setValue])

  const itemsByName = useMemo(
    () => {
      const result: { [name: string]: Item[] | undefined } = {}
      for (const i of allItems) {
        const name = getItemName(i)
        if (result[name] === undefined) {
          result[name] = [i]
        } else {
          result[name]!.push(i)
        }
      }
      return result
    },
    [allItems],
  )

  const duplicates = useMemo(
    () => {
      const potential = itemsByName[getItemName({ name: nameValue, type: item.type })]
      if (potential) {
        return potential.filter(i => i.type === item.type && i.id !== item.id)
      }
      return []
    },
    [item.id, item.type, itemsByName, nameValue],
  )

  const defaultExpandAccordions = !fromPrayerPage
  const hasDescription = !!descriptionValue
  const isArchivedInPrayer = fromPrayerPage && !!item.archived

  const nameInputProps = useMemo(
    () => {
      if (showDescription) {
        return undefined
      }

      return {
        endAdornment: (
          <InputAdornment position="end">
            <Tooltip title="Add description">
              <IconButton
                aria-label="Add description"
                data-cy="add-description"
                onClick={handleAddDescription}
                size="small"
              >
                <NotesIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </InputAdornment>
        ),
      }
    },
    [handleAddDescription, showDescription],
  )

  const nameFields = useMemo(
    () => (
      <Grid size={{ xs: 12 }}>
        <Controller
          control={control}
          name="name"
          render={({ field }) => (
            <TextField
              autoFocus={autoFocusName}
              error={!!errors.name}
              fullWidth
              helperText={errors.name?.message || ' '}
              label="Name"
              onChange={field.onChange}
              required
              value={field.value}
              variant="standard"
              slotProps={{
                htmlInput: { 'data-cy': 'name' },
                input: nameInputProps,
              }}
            />
          )}
        />
      </Grid>
    ),
    [autoFocusName, control, errors.name, nameInputProps],
  )

  const descriptionField = useMemo(
    () =>
      showDescription && (
        <Grid size={{ xs: 12 }}>
          <Controller
            control={control}
            name="description"
            render={({ field }) => (
              <TextField
                error={!!errors.description}
                fullWidth
                helperText={errors.description?.message || ' '}
                label="Short Description"
                slotProps={{
                  htmlInput: { 'data-cy': 'description' },
                  input: {
                    endAdornment: (
                      <InputAdornment position="end">
                        <Tooltip title="Remove description">
                          <IconButton
                            aria-label="Remove description"
                            data-cy="remove-description"
                            onClick={handleRemoveDescription}
                            size="small"
                          >
                            <DeleteIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                      </InputAdornment>
                    ),
                  },
                }}
                onChange={field.onChange}
                value={field.value}
                variant="standard"
              />
            )}
          />
        </Grid>
      ),
    [control, errors.description, handleRemoveDescription, showDescription],
  )


  return (
    <FormProvider {...formMethods}>
      <Grid container spacing={2}>
        {!hideHeaderFields && (
          <ItemFormDuplicateAlertSection
            duplicateCount={duplicates.length}
            hasDescription={hasDescription}
            itemType={item.type}
          />
        )}
        {!hideHeaderFields && nameFields}
        {!hideHeaderFields && descriptionField}
        <ItemFormNotesSection
          disabled={isArchivedInPrayer}
          itemId={item.id}
        />
        <ItemFormFrequencySection
          defaultExpandAccordions={defaultExpandAccordions}
          disabled={isArchivedInPrayer}
          item={item}
        />
        {!hideRelationships && (
          <ItemFormRelationshipsSection
            defaultExpandAccordions={defaultExpandAccordions}
            item={item}
          />
        )}
      </Grid>
    </FormProvider>
  )
}

export default ItemFormContent

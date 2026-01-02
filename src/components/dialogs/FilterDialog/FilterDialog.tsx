import { useCallback, useState } from 'react'
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
} from '@mui/material'
import { useAppDispatch, useAppSelector } from '../../../store'
import { setUi } from '../../../state/ui'
import { DEFAULT_FILTER_CRITERIA, FILTER_CRITERIA_DISPLAY, FILTER_CRITERIA_DISPLAY_MAP } from '../../../utils/customFilter'
import { FilterCriterionDisplay } from './FilterCriterionDisplay'
import type { FilterCriterion } from '../../../utils/customFilter'

export interface Props {
  onClose: () => void,
  open: boolean,
}

function FilterDialog({
  onClose,
  open,
}: Props) {
  const dispatch = useAppDispatch()
  const filterCriteria = useAppSelector(state => state.ui.filters)
  const [localCriteria, setLocalCriteria] = useState<FilterCriterion[]>([])
  const [prevOpen, setPrevOpen] = useState(open)
  if (open && !prevOpen) {
    setPrevOpen(true)
    const criteria = filterCriteria.filter(fc => !!FILTER_CRITERIA_DISPLAY_MAP[(fc as FilterCriterion).type])
    if (criteria.length > 0) {
      setLocalCriteria(criteria)
    } else {
      setLocalCriteria(DEFAULT_FILTER_CRITERIA)
    }
  } else if (!open && prevOpen) {
    setPrevOpen(false)
  }

  const handleAdd = useCallback(
    () => setLocalCriteria(lc => {
      return [
        ...lc,
        ...DEFAULT_FILTER_CRITERIA,
      ]
    }),
    [],
  )
  const handleChange = useCallback(
    (index: number, criterion: FilterCriterion) => (
      setLocalCriteria(prevCriteria => {
        if (index >= 0 && index < prevCriteria.length) {
          const copy = [...prevCriteria]
          copy[index] = criterion
          return copy
        }
        return [...prevCriteria, criterion]
      })
    ),
    [],
  )
  const handleRemove = useCallback(
    (index: number) => setLocalCriteria(
      prevCriteria => prevCriteria.filter((_, i) => i !== index),
    ),
    [],
  )
  const handleClear = useCallback(
    () => {
      setLocalCriteria([])
      dispatch(setUi({ filters: [] }))
    },
    [dispatch],
  )
  const handleDone = useCallback(
    () => {
      dispatch(setUi({ filters: localCriteria }))
      onClose()
    },
    [dispatch, localCriteria, onClose],
  )

  return (
    <Dialog
      onClose={onClose}
      open={open}
      fullWidth
      maxWidth="sm"
    >
      <DialogTitle>
        Filter Conditions
      </DialogTitle>

      <DialogContent>
        {localCriteria.map((lc, index) => {
          const chosenForRow = new Set(localCriteria.filter((_, i) => i !== index).map(c => c.type))
          return (
            <div key={`${lc.type}-${index}`}>
              {index === 0 && <Divider />}

              <FilterCriterionDisplay
                criterion={lc}
                chosenCriteria={chosenForRow}
                onChange={handleChange}
                onRemove={handleRemove}
                index={index}
              />

              <Divider />
            </div>
          )
        })}

        <Button
          data-cy="add-filter-criterion"
          disabled={localCriteria.length >= FILTER_CRITERIA_DISPLAY.length}
          fullWidth
          onClick={handleAdd}
          variant="outlined"
        >
          Add filter condition
        </Button>
      </DialogContent>

      <DialogActions>
        <Button
          data-cy="filter-cancel"
          disabled={localCriteria.length === 0}
          fullWidth
          onClick={handleClear}
          variant="outlined"
        >
          Clear
        </Button>

        <Button
          color="primary"
          data-cy="filter-done"
          fullWidth
          onClick={handleDone}
          variant="contained"
        >
          Done
        </Button>
      </DialogActions>
    </Dialog>
  )
}

export default FilterDialog

import { useCallback, useState } from 'react'
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
} from '@mui/material'
import { useUiStore } from '../../../state/uiStore'
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
  const setUi = useUiStore(state => state.setUi)
  const filterCriteria = useUiStore(state => state.filters)
  const [localCriteria, setLocalCriteria] = useState<FilterCriterion[]>([])

  const initializeLocalCriteria = useCallback(() => {
    const criteria = filterCriteria.filter(fc => !!FILTER_CRITERIA_DISPLAY_MAP[(fc as FilterCriterion).type])
    if (criteria.length > 0) {
      setLocalCriteria(criteria)
    } else {
      setLocalCriteria(DEFAULT_FILTER_CRITERIA)
    }
  }, [filterCriteria])

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
      setUi({ filters: [] })
    },
    [setUi],
  )
  const handleDone = useCallback(
    () => {
      setUi({ filters: localCriteria })
      onClose()
    },
    [localCriteria, onClose, setUi],
  )

  return (
    <Dialog
      onClose={onClose}
      open={open}
      fullWidth
      maxWidth="sm"
      TransitionProps={{ onEnter: initializeLocalCriteria }}
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

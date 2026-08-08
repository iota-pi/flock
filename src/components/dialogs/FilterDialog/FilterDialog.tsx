import { useCallback, useMemo, useState } from 'react'
import Button from '@mui/material/Button'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import Divider from '@mui/material/Divider'

import { useAppStore } from 'src/state/store'
import {
  DEFAULT_FILTER_CRITERIA,
  FILTER_CRITERIA_DISPLAY_MAP,
  DEFAULT_ADDITIONAL_FILTER_CRITERION,
  getAvailableFilterCriteria,
} from 'src/utils/customFilter'
import { FilterCriterionDisplay } from './FilterCriterionDisplay'
import type { FilterCriterion } from 'src/utils/customFilter'
import type { ItemType } from 'src/shared/itemTypes'


interface Props {
  itemType?: ItemType,
  onClose: () => void,
  open: boolean,
}

function FilterDialog({
  itemType,
  onClose,
  open,
}: Props) {
  const setUi = useAppStore(state => state.setUi)
  const filterCriteria = useAppStore(state => state.filters)
  const [localCriteria, setLocalCriteria] = useState<FilterCriterion[]>([])

  const availableCriteria = useMemo(() => getAvailableFilterCriteria(itemType), [itemType])

  const initializeLocalCriteria = useCallback(() => {
    const criteria = filterCriteria.filter(fc => (
      availableCriteria.includes((fc as FilterCriterion).type) && !!FILTER_CRITERIA_DISPLAY_MAP[(fc as FilterCriterion).type]
    ))
    if (criteria.length > 0) {
      setLocalCriteria(criteria)
    } else {
      setLocalCriteria(DEFAULT_FILTER_CRITERIA)
    }
  }, [availableCriteria, filterCriteria])

  const handleAdd = useCallback(
    () => setLocalCriteria(lc => {
      return [
        ...lc,
        {
          ...DEFAULT_ADDITIONAL_FILTER_CRITERION,
        },
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
      slotProps={{ transition: { onEnter: initializeLocalCriteria } }}
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
                availableCriteria={availableCriteria}
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
          disabled={localCriteria.length >= availableCriteria.length}
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

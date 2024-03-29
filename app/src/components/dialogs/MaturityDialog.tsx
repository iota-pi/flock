import { ChangeEvent, useCallback, useEffect, useState } from 'react'
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  InputAdornment,
  Stack,
  TextField,
  Typography,
} from '@mui/material'
import FlipMove from 'react-flip-move'
import ExpandLessIcon from '@mui/icons-material/ExpandLess'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import { generateItemId } from '../../utils'
import { RemoveIcon } from '../Icons'
import { PersonItem } from '../../state/items'
import { useItems, useMaturity } from '../../state/selectors'
import { MaturityControl, updateMaturityForPeople } from '../../utils/maturity'


export interface Props {
  onClose: () => void,
  open: boolean,
}

function MaturitySingleStage({
  autoFocus,
  index,
  lastIndex,
  onChange,
  onMoveDown,
  onMoveUp,
  onRemove,
  stage,
}: {
  autoFocus: boolean,
  index: number,
  lastIndex: number,
  onChange: (id: string, name: string) => void,
  onMoveDown: (id: string) => void,
  onMoveUp: (id: string) => void,
  onRemove: (id: string) => void,
  stage: MaturityControl,
}) {
  const handleRemove = useCallback(() => onRemove(stage.id), [onRemove, stage.id])
  const handleMoveDown = useCallback(() => onMoveDown(stage.id), [onMoveDown, stage.id])
  const handleMoveUp = useCallback(() => onMoveUp(stage.id), [onMoveUp, stage.id])
  const handleChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => onChange(stage.id, event.target.value),
    [onChange, stage.id],
  )

  return (
    <Box
      display="flex"
      alignItems="center"
      flexGrow={1}
      data-cy="maturity-stage"
    >
      <Box
        display="flex"
        flexDirection="column"
        mr={2}
      >
        <IconButton
          data-cy="maturity-move-up"
          disabled={index === 0}
          onClick={handleMoveUp}
          size="small"
        >
          <ExpandLessIcon />
        </IconButton>

        <IconButton
          data-cy="maturity-move-down"
          disabled={index === lastIndex}
          onClick={handleMoveDown}
          size="small"
        >
          <ExpandMoreIcon />
        </IconButton>
      </Box>

      <Box mr={2}>
        <Typography fontWeight={500}>
          {index + 1}.
        </Typography>
      </Box>

      <TextField
        autoFocus={autoFocus}
        data-cy="maturity-stage-name"
        fullWidth
        onChange={handleChange}
        value={stage.name}
        InputProps={{
          endAdornment: (
            <InputAdornment position="end">
              <IconButton
                data-cy="maturity-remove-stage"
                onClick={handleRemove}
                size="small"
              >
                <RemoveIcon />
              </IconButton>
            </InputAdornment>
          ),
        }}
        variant="standard"
      />
    </Box>
  )
}

function MaturityDialog({
  onClose,
  open,
}: Props) {
  const people = useItems<PersonItem>('person')

  const [maturity, setMaturity] = useMaturity()
  const [localMaturity, setLocalMaturity] = useState<MaturityControl[]>([])
  const [original, setOriginal] = useState<MaturityControl[]>([])
  const [disableAnimation, setDisableAnimation] = useState(false)
  const [autoFocusId, setAutoFocusId] = useState<string>()

  useEffect(
    () => {
      const withIds = maturity.map(m => ({ id: generateItemId(), name: m }))
      setLocalMaturity(withIds)
      setOriginal(withIds)
    },
    [maturity],
  )
  useEffect(
    () => {
      if (disableAnimation) {
        setDisableAnimation(false)
      }
    },
    [disableAnimation],
  )

  const handleAdd = useCallback(
    () => {
      setDisableAnimation(true)
      const id = generateItemId()
      setLocalMaturity(lm => [...lm, { id, name: '' }])
      setAutoFocusId(id)
    },
    [],
  )
  const handleChange = useCallback(
    (id: string, name: string) => setLocalMaturity(lm => {
      const index = lm.findIndex(m => m.id === id)
      return [
        ...lm.slice(0, index),
        { ...lm[index], name },
        ...lm.slice(index + 1),
      ]
    }),
    [],
  )
  const handleMoveDown = useCallback(
    (id: string) => setLocalMaturity(lm => {
      const index = lm.findIndex(m => m.id === id)
      return [
        ...lm.slice(0, index),
        lm[index + 1],
        lm[index],
        ...lm.slice(index + 2),
      ]
    }),
    [],
  )
  const handleMoveUp = useCallback(
    (id: string) => setLocalMaturity(lm => {
      const index = lm.findIndex(m => m.id === id)
      return [
        ...lm.slice(0, index - 1),
        lm[index],
        lm[index - 1],
        ...lm.slice(index + 1),
      ]
    }),
    [],
  )
  const handleRemove = useCallback(
    (id: string) => {
      setDisableAnimation(true)
      setLocalMaturity(lm => lm.filter(m => m.id !== id))
    },
    [],
  )
  const handleDone = useCallback(
    async () => {
      await updateMaturityForPeople(people, original, localMaturity)
      setMaturity(localMaturity.map(m => m.name.trim()).filter(m => m))
      onClose()
    },
    [
      localMaturity,
      onClose,
      original,
      people,
      setMaturity,
    ],
  )

  return (
    <Dialog
      onClose={onClose}
      open={open}
      fullWidth
      maxWidth="sm"
    >
      <DialogTitle>
        Edit Maturity Stages
      </DialogTitle>

      <DialogContent>
        <Stack spacing={2}>
          <FlipMove
            enterAnimation="none"
            leaveAnimation="none"
            disableAllAnimations={disableAnimation}
          >
            {localMaturity.map((lm, index) => (
              <div key={lm.id}>
                {index === 0 && <Divider />}

                <MaturitySingleStage
                  autoFocus={lm.id === autoFocusId}
                  index={index}
                  lastIndex={localMaturity.length - 1}
                  onChange={handleChange}
                  onMoveDown={handleMoveDown}
                  onMoveUp={handleMoveUp}
                  onRemove={handleRemove}
                  stage={lm}
                />

                <Divider />
              </div>
            ))}
          </FlipMove>

          <Button
            data-cy="maturity-add-stage"
            fullWidth
            onClick={handleAdd}
            variant="outlined"
          >
            Add maturity stage
          </Button>
        </Stack>
      </DialogContent>

      <DialogActions>
        <Button
          data-cy="maturity-cancel"
          fullWidth
          onClick={onClose}
          variant="outlined"
        >
          Cancel
        </Button>

        <Button
          color="primary"
          data-cy="maturity-done"
          disabled={localMaturity.length === 0}
          fullWidth
          onClick={handleDone}
          variant="contained"
        >
          Save
        </Button>
      </DialogActions>
    </Dialog>
  )
}

export default MaturityDialog

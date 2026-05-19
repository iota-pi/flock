import {
  useCallback,
  useState,
} from 'react'
import {
  Button,
  Container,
  Divider,
  Grid,
  styled,
  Typography,
} from '@mui/material'
import ConfirmationDialog from '../../dialogs/ConfirmationDialog'
import { DeleteIcon, SaveIcon } from '../../Icons'
import InlineText from '../../ui/InlineText'


const StyledContainer = styled(Container)(({ theme }) => ({
  paddingTop: theme.spacing(2),
  paddingBottom: theme.spacing(2),
}))

interface BaseProps {
  canSend?: boolean,
  itemIsNew?: boolean,
  itemName?: string,
  permanentDrawer?: boolean,
  promptSave?: boolean,
}

interface PropsWithSave extends BaseProps {
  canSave: boolean,
  disableAutoCloseOnSave?: boolean,
  onCancel: () => void,
  onDelete: () => void,
  onDone?: undefined,
  onSave: () => void,
  onSkip?: undefined,
}

interface PropsWithDone extends BaseProps {
  canSave?: undefined,
  disableAutoCloseOnSave?: undefined,
  onCancel?: undefined,
  onDelete?: undefined,
  onDone: () => void,
  onSave?: undefined,
  onSkip?: () => void,
}

interface PropsWithNext extends BaseProps {
  canSave?: undefined,
  disableAutoCloseOnSave?: undefined,
  onCancel?: undefined,
  onDelete?: undefined,
  onDone?: undefined,
  onSave?: undefined,
  onSkip: () => void,
}

export type Props = PropsWithSave | PropsWithDone | PropsWithNext


function DrawerActions({
  canSave,
  disableAutoCloseOnSave,
  itemIsNew,
  itemName,
  onCancel,
  onDelete,
  onDone,
  onSave,
  onSkip,
  permanentDrawer,
  promptSave = true,
}: Props) {
  const [showConfirm, setShowConfirm] = useState(false)

  const handleInitialClickDelete = useCallback(
    () => {
      if (!itemIsNew) {
        setShowConfirm(true)
      } else if (onCancel) {
        onCancel()
      }
    },
    [itemIsNew, onCancel],
  )
  const handleClickConfirmCancel = useCallback(() => setShowConfirm(false), [])

  const handleDelete = useCallback(
    () => {
      setShowConfirm(false)
      onDelete?.()
    },
    [onDelete],
  )

  return (
    <>
      <Divider />

      <StyledContainer>
        <Grid container spacing={2}>
          {onSkip && (
            <Grid size={{ xs: 12 }}>
              <Button
                data-cy="drawer-skip"
                fullWidth
                onClick={onSkip}
                variant="outlined"
              >
                Skip
              </Button>
            </Grid>
          )}

          {onCancel && (
            <Grid size={{ xs: 12, sm: 6 }}>
              <Button
                color={itemIsNew ? undefined : 'error'}
                data-cy="drawer-cancel"
                fullWidth
                onClick={handleInitialClickDelete}
                startIcon={itemIsNew ? undefined : <DeleteIcon />}
                variant="outlined"
              >
                {itemIsNew ? 'Cancel' : 'Delete'}
              </Button>
            </Grid>
          )}

          {onSave && (
            <Grid size={{ xs: 12, sm: 6 }}>
              <Button
                color="primary"
                data-cy="drawer-done"
                disabled={!canSave}
                fullWidth
                onClick={onSave}
                startIcon={<SaveIcon />}
                variant={promptSave || itemIsNew ? 'contained' : 'outlined'}
              >
                {(permanentDrawer || disableAutoCloseOnSave) && promptSave ? 'Save' : 'Done'}
              </Button>
            </Grid>
          )}

          {onDone && (
            <Grid size={{ xs: 12 }}>
              <Button
                color="primary"
                data-cy="drawer-done"
                fullWidth
                onClick={onDone}
                variant="contained"
              >
                Done
              </Button>
            </Grid>
          )}
        </Grid>
      </StyledContainer>

      {onDelete && (
        <ConfirmationDialog
          open={showConfirm}
          onConfirm={handleDelete}
          onCancel={handleClickConfirmCancel}
        >
          <Typography>
            Are you sure you want to delete
            {' '}
            <InlineText fontWeight={500}>
              {itemName}
            </InlineText>
            ?
          </Typography>

          <Typography>
            This action cannot be undone.
          </Typography>
        </ConfirmationDialog>
      )}
    </>
  )
}

export default DrawerActions

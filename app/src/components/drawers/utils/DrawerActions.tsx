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
import { DeleteIcon, MessageIcon, NextIcon, ReportIcon, SaveIcon } from '../../Icons'
import InlineText from '../../InlineText'


const StyledContainer = styled(Container)(({ theme }) => ({
  paddingTop: theme.spacing(2),
  paddingBottom: theme.spacing(2),
}))

export interface BaseProps {
  canSend?: boolean,
  itemIsNew?: boolean,
  itemName?: string,
  onSend?: () => void,
  permanentDrawer?: boolean,
  promptSave?: boolean,
}

export interface PropsWithSave extends BaseProps {
  canSave: boolean,
  disableAutoCloseOnSave?: boolean,
  onCancel: () => void,
  onDelete: () => void,
  onDone?: undefined,
  onNext?: undefined,
  onReport?: () => void,
  onSave: () => void,
  onSkip?: undefined,
}

export interface PropsWithDone extends BaseProps {
  canSave?: undefined,
  disableAutoCloseOnSave?: undefined,
  onCancel?: undefined,
  onDelete?: undefined,
  onDone: () => void,
  onNext?: undefined,
  onReport?: undefined,
  onSave?: undefined,
  onSkip?: () => void,
}

export interface PropsWithNext extends BaseProps {
  canSave?: undefined,
  disableAutoCloseOnSave?: undefined,
  onCancel?: undefined,
  onDelete?: undefined,
  onDone?: undefined,
  onNext: () => void,
  onReport?: undefined,
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
  onNext,
  onReport,
  onSave,
  onSend,
  onSkip,
  permanentDrawer,
  promptSave = true,
}: Props) {
  const [showConfirm, setShowConfirm] = useState(false)

  const handleClickDelete = useCallback(
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

  return (
    <>
      <Divider />

      <StyledContainer>
        <Grid container spacing={2}>
          {onSend && (
            <Grid item xs={12}>
              <Button
                data-cy="drawer-send"
                fullWidth
                onClick={onSend}
                startIcon={<MessageIcon />}
                variant="outlined"
              >
                Send Message
              </Button>
            </Grid>
          )}

          {onReport && (
            <Grid item xs={12}>
              <Button
                data-cy="drawer-report"
                disabled={itemIsNew}
                fullWidth
                onClick={onReport}
                startIcon={itemIsNew ? undefined : <ReportIcon />}
                variant="outlined"
              >
                Group Report
              </Button>
            </Grid>
          )}

          {onSkip && (
            <Grid item xs={12}>
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
            <Grid item xs={12} sm={6}>
              <Button
                color={itemIsNew ? undefined : 'error'}
                data-cy="drawer-cancel"
                fullWidth
                onClick={handleClickDelete}
                startIcon={itemIsNew ? undefined : <DeleteIcon />}
                variant="outlined"
              >
                {itemIsNew ? 'Cancel' : 'Delete'}
              </Button>
            </Grid>
          )}

          {onSave && (
            <Grid item xs={12} sm={6}>
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
            <Grid item xs={12}>
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

          {onNext && (
            <Grid item xs={12}>
              <Button
                color="primary"
                data-cy="drawer-next"
                endIcon={<NextIcon />}
                fullWidth
                onClick={onNext}
                variant="contained"
              >
                Next
              </Button>
            </Grid>
          )}
        </Grid>
      </StyledContainer>

      {onDelete && (
        <ConfirmationDialog
          open={showConfirm}
          onConfirm={onDelete}
          onCancel={handleClickConfirmCancel}
        >
          <Typography paragraph>
            Are you sure you want to delete
            {' '}
            <InlineText fontWeight={500}>
              {itemName}
            </InlineText>
            ?
          </Typography>

          <Typography paragraph>
            This action cannot be undone.
          </Typography>
        </ConfirmationDialog>
      )}
    </>
  )
}

export default DrawerActions

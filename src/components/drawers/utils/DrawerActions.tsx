import Button from '@mui/material/Button'
import Container from '@mui/material/Container'
import Divider from '@mui/material/Divider'
import Grid from '@mui/material/Grid'
import { styled } from '@mui/material/styles'

import { SaveIcon } from '../../Icons'


const StyledContainer = styled(Container)(({ theme }) => ({
  paddingTop: theme.spacing(2),
  paddingBottom: theme.spacing(2),
}))

interface BaseProps {
  canSend?: boolean,
}

interface PropsWithSave extends BaseProps {
  canSave: boolean,
  onDone?: undefined,
  onSave: () => void,
}

interface PropsWithDone extends BaseProps {
  canSave?: undefined,
  onDone: () => void,
  onSave?: undefined,
}

interface PropsWithNext extends BaseProps {
  canSave?: undefined,
  onDone?: undefined,
  onSave?: undefined,
}

export type Props = PropsWithSave | PropsWithDone | PropsWithNext


function DrawerActions({
  canSave,
  onDone,
  onSave,
}: Props) {
  return (
    <>
      <Divider />

      <StyledContainer>
        <Grid container spacing={2}>
          {onSave && (
            <Grid size={{ xs: 12 }}>
              <Button
                color="primary"
                data-cy="drawer-done"
                fullWidth
                onClick={onSave}
                startIcon={canSave ? <SaveIcon /> : undefined}
                variant={canSave ? 'contained' : 'outlined'}
              >
                {canSave ? 'Done' : 'Cancel'}
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
    </>
  )
}

export default DrawerActions

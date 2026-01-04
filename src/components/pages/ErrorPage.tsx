import { isRouteErrorResponse, useRouteError } from 'react-router'
import {
  Box,
  Button,
  Container,
  Typography,
  styled,
} from '@mui/material'

const Root = styled('div')({
  flexGrow: 1,
  overflowY: 'auto',
  display: 'flex',
  justifyContent: 'center',
  alignItems: 'center',
  minHeight: '100vh',
})

const MainContainer = styled(Container)(({ theme }) => ({
  padding: theme.spacing(4),
  textAlign: 'center',
}))

export default function ErrorPage() {
  const error = useRouteError()
  console.error(error)

  let errorMessage = 'An unexpected error has occurred.'
  if (isRouteErrorResponse(error)) {
    // error is type `ErrorResponse`
    errorMessage = error.statusText || error.data?.message || errorMessage
  } else if (error instanceof Error) {
    errorMessage = error.message
  } else if (typeof error === 'string') {
    errorMessage = error
  }

  return (
    <Root>
      <MainContainer maxWidth="sm">
        <Typography variant="h2" gutterBottom>
          Oops!
        </Typography>
        <Typography variant="h5" paragraph>
          Sorry, something went wrong.
        </Typography>
        <Typography color="error" paragraph>
          {errorMessage}
        </Typography>
        <Box mt={4}>
          <Button
            variant="contained"
            color="primary"
            onClick={() => window.location.reload()}
          >
            Reload Page
          </Button>
        </Box>
      </MainContainer>
    </Root>
  )
}

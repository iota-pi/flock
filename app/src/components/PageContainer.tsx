import { Container, styled } from '@mui/material';

const PageContainer = styled(Container)(({ theme }) => ({
  flexGrow: 1,
  paddingTop: theme.spacing(2),
  paddingBottom: theme.spacing(2),

  '&:not(:first-child)': {
    marginTop: theme.spacing(2),
  },
}));

export default PageContainer;

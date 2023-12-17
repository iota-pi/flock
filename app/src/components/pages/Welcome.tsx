import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Button,
  Container,
  Grid,
  Link,
  styled,
  Typography,
} from '@mui/material';
import { getPage } from '.';
import AboutDrawer from '../drawers/AboutDrawer';


const Root = styled('div')({
  flexGrow: 1,
  overflowY: 'auto',
});
const MainContainer = styled(Container)(({ theme }) => ({
  flexGrow: 1,
  overflowY: 'auto',
  padding: theme.spacing(4),
  position: 'relative',
}));
const Section = styled('div')(({ theme }) => ({
  alignItems: 'center',
  display: 'flex',
  flexDirection: 'column',
  flexGrow: 1,
  justifyContent: 'center',
  paddingBottom: theme.spacing(8),
}));
const LargeText = styled(Typography)(({ theme }) => ({
  fontSize: theme.typography.h5.fontSize,
  fontWeight: 300,
}));


function WelcomePage() {
  const navigate = useNavigate();

  const [showAbout, setShowAbout] = useState(false);
  const handleClickLearnMore = useCallback(() => setShowAbout(true), []);
  const handleCloseAbout = useCallback(() => setShowAbout(false), []);
  const handleClickCreate = useCallback(
    () => {
      navigate(getPage('signup').path);
    },
    [navigate],
  );
  const handleClickLogin = useCallback(
    () => navigate(getPage('login').path),
    [navigate],
  );

  return (
    <Root>
      <MainContainer maxWidth="md">
        <Section>
          <img src="/flock.png" alt="" width="300" height="300" />

          <Typography
            variant="h2"
            style={{ fontWeight: 300 }}
          >
            Flock
          </Typography>
        </Section>

        <Section>
          <div>
            <LargeText paragraph>
              Flock is a tool to help you care diligently for the flock of God that is among you.
            </LargeText>

            <LargeText paragraph>
              Flock aims to provide you with a secure, digital &quot;notebook&quot; to help you to
              remember and care for your Flock, especially in prayer.
            </LargeText>

            <LargeText paragraph>
              <Link
                component="button"
                onClick={handleClickLearnMore}
                variant="body1"
              >
                Learn more
              </Link>
            </LargeText>
          </div>
        </Section>

        <Section>
          <Typography
            gutterBottom
            variant="h3"
            style={{ fontWeight: 300 }}
          >
            Get Started
          </Typography>

          <Grid container spacing={2} justifyContent="center">
            <Grid item xs={12} sm={4}>
              <Button
                color="primary"
                data-cy="create-account"
                fullWidth
                onClick={handleClickCreate}
                size="large"
                variant="contained"
              >
                Create Account
              </Button>
            </Grid>

            <Grid item xs={12} sm={4}>
              <Button
                color="primary"
                fullWidth
                onClick={handleClickLogin}
                size="large"
                variant="contained"
              >
                Login
              </Button>
            </Grid>
          </Grid>
        </Section>

        <AboutDrawer
          open={showAbout}
          onClose={handleCloseAbout}
        />
      </MainContainer>
    </Root>
  );
}

export default WelcomePage;

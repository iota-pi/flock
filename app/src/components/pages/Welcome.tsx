import { useCallback, useState } from 'react';
import { useHistory } from 'react-router-dom';
import {
  Button,
  Container,
  Grid,
  Link,
  styled,
  Typography,
} from '@material-ui/core';
import { getPage } from '.';
import AboutDrawer from '../drawers/AboutDrawer';


const Root = styled(Container)(({ theme }) => ({
  padding: theme.spacing(4),
  flexGrow: 1,
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
  const history = useHistory();

  const [showAbout, setShowAbout] = useState(false);
  const handleClickLearnMore = useCallback(() => setShowAbout(true), []);
  const handleCloseAbout = useCallback(() => setShowAbout(false), []);
  const handleClickCreate = useCallback(
    () => {
      history.push(getPage('signup').path);
    },
    [history],
  );
  const handleClickLogin = useCallback(
    () => history.push(getPage('login').path),
    [history],
  );

  return (
    <Root maxWidth="md">
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
            {/* eslint-disable-next-line jsx-a11y/anchor-is-valid */}
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
    </Root>
  );
}

export default WelcomePage;

import { Typography } from '@material-ui/core';
import BaseDrawer, { BaseDrawerProps } from './BaseDrawer';

export interface Props extends BaseDrawerProps {}

function AboutDrawer({
  onClose,
  open,
}: Props) {
  return (
    <BaseDrawer
      ActionProps={{
        onDone: onClose,
      }}
      alwaysTemporary
      alwaysShowBack
      hideTypeIcon
      onBack={onClose}
      onClose={onClose}
      open={open}
    >
      <img src="/flock.png" alt="" width="120" height="120" />

      <Typography
        gutterBottom
        style={{ fontWeight: 300 }}
        variant="h4"
      >
        Flock
      </Typography>

      <Typography paragraph>
        Flock is Pastoral Relationship Management (PRM) software. Our prayer is that
        Flock will help you to care diligently for the flock of God that is among you.
      </Typography>

      <Typography
        gutterBottom
        style={{ fontWeight: 300 }}
        variant="h5"
      >
        Intent
      </Typography>

      <Typography paragraph>
        Flock is intended as a tool to help you to care for and serve your people.
        As such it designed to be used by multiple users, or to share data between
        users.
      </Typography>

      <Typography paragraph>
        Because Flock is a personal tool, the data you enter should not belong to your
        organisation or church.
      </Typography>

      <Typography
        gutterBottom
        style={{ fontWeight: 300 }}
        variant="h5"
      >
        Security
      </Typography>

      <Typography paragraph>
        Any data you enter is stored encrypted using
        {' '}<i>client-side encryption</i>{' '}
        (sometimes also referred to as <i>end-to-end encryption</i>).
        Practically speaking, this means that there is no way for anyone (including you)
        to read or recover your data without your password
        (and the account ID generated for you when creating your account).
      </Typography>

      <Typography paragraph>
        As such, the security of Flock can only be as good as your own online security.
        We <b>strongly</b> recommend using a password manager
        to create and record a strong password and your account ID.
      </Typography>

      <Typography paragraph>
        Similarly, leaving your laptop unattended and unlocked while logged in to Flock
        would be unwise.
      </Typography>

      <Typography
        gutterBottom
        style={{ fontWeight: 300 }}
        variant="h5"
      >
        Disclaimer
      </Typography>

      <Typography paragraph>
        Flock is free software, provided as-is, with no guarantee of data retention,
        security, or availability. By choosing to use Flock, you agree that the
        creators and contributors shall not be liable for any damages or losses
        related to or resulting from the use of Flock.
      </Typography>
    </BaseDrawer>
  );
}

export default AboutDrawer;

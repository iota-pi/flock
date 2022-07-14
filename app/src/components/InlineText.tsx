import { Typography, TypographyProps } from '@mui/material';

const InlineText = (props: TypographyProps) => (
  <Typography component="span" {...props} />
);
export default InlineText;

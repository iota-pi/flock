import { Typography, TypographyProps } from '@mui/material'

const InlineText = (props: TypographyProps) => (
  <Typography
    component="span"
    {...props}
    sx={{
      fontWeight: 'fontWeightMedium',
      ...props.sx,
    }}
  />
)
export default InlineText

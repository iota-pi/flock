import Typography, { TypographyProps } from '@mui/material/Typography'


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

import { Theme } from '@mui/material'
import { useCallback } from 'react'
import { MuiIconType } from './Icons'


interface Props {
  icon: MuiIconType,
}

function LargeIcon({
  icon: Icon,
}: Props) {
  const getStyle = useCallback(
    (theme: Theme) => ({
      width: theme.typography.h1.fontSize,
      height: theme.typography.h1.fontSize,
    }),
    [],
  )

  return (
    <Icon sx={getStyle} />
  )
}

export default LargeIcon

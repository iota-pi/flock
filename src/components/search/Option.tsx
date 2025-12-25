import { useCallback, useMemo } from 'react'
import {
  Box,
  Checkbox,
  Divider,
  styled,
  Theme,
  Typography,
} from '@mui/material'
import { isItem, getItemTypeLabel } from '../../state/items'
import InlineText from '../InlineText'
import { getIcon } from '../Icons'
import { AnySearchable } from './types'
import { getName, isSearchableStandardItem } from './utils'

export const AutocompleteOption = styled('div')(({ theme }) => ({
  alignItems: 'center',
  display: 'flex',
  minWidth: 0,
  padding: theme.spacing(1.75, 0),
}))
export const OptionIconHolder = styled('div')(({ theme }) => ({
  display: 'flex',
  alignItems: 'center',
  paddingRight: theme.spacing(2),
}))
export const OptionName = styled(InlineText)({
  flexGrow: 1,
  minWidth: 0,
})

export default function OptionComponent({
  option,
  showDescription,
  showGroupMemberCount,
  showIcon,
  showCheckbox,
  selected,
}: {
  option: AnySearchable,
  showDescription: boolean,
  showGroupMemberCount: boolean,
  showIcon: boolean,
  showCheckbox: boolean,
  selected: boolean,
}) {
  const icon = getIcon(option.type)
  const name = getName(option)
  const item = isSearchableStandardItem(option) ? option.data : undefined

  const groupMembersText = useMemo(
    () => {
      if (item && item.type === 'group') {
        const count = item.members.length
        const s = count !== 1 ? 's' : ''
        return ` (${count} member${s})`
      }
      return ''
    },
    [item],
  )
  const clippedDescription = useMemo(
    () => {
      if (item && isItem(item)) {
        const base = item.description
        const clipped = base.slice(0, 100)
        if (clipped.length < base.length) {
          const clippedToWord = clipped.slice(0, clipped.lastIndexOf(' '))
          return `${clippedToWord}…`
        }
        return base
      }
      return null
    },
    [item],
  )

  const getFontSize = useCallback(
    (theme: Theme) => theme.typography.caption.fontSize,
    [],
  )

  return (
    <>
      {option.dividerBefore && <Divider />}

      <AutocompleteOption>
        {showCheckbox && (
          <OptionIconHolder>
            <Checkbox size="small" checked={!!selected} tabIndex={-1} disableRipple />
          </OptionIconHolder>
        )}
        {showIcon && (
          <OptionIconHolder>
            {icon}
          </OptionIconHolder>
        )}

        {option.create ? (
          <div>
            <span>Add {getItemTypeLabel(option.type).toLowerCase()} </span>
            <Typography fontWeight={500}>
              {name}
            </Typography>
          </div>
        ) : (
          <Box minWidth={0}>
            <Typography display="flex" alignItems="center">
              <OptionName noWrap>
                {name}
              </OptionName>

              <InlineText
                color="text.secondary"
                fontWeight={300}
                whiteSpace="pre"
              >
                {showGroupMemberCount && option.type === 'group' ? groupMembersText : ''}
              </InlineText>
            </Typography>

            {showDescription && clippedDescription && (
              <InlineText
                color="text.secondary"
                fontSize={getFontSize}
                noWrap
              >
                {clippedDescription}
              </InlineText>
            )}
          </Box>
        )}
      </AutocompleteOption>
    </>
  )
}

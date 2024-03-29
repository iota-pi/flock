import { useMemo } from 'react'
import { Box, Typography } from '@mui/material'
import BaseDrawer, { BaseDrawerProps } from './BaseDrawer'
import LargeIcon from '../LargeIcon'
import { InternalPageId, PageId, usePage } from '../pages'
import InlineText from '../InlineText'

export interface Props extends BaseDrawerProps {}

const pagesWithAddButton: PageId[] = [
  'groups',
  'people',
  'prayer',
]

const itemNameMap: Record<Exclude<PageId, InternalPageId>, string> = {
  groups: 'group',
  people: 'person',
  prayer: 'item',
  settings: 'item',
}
const addNameMap: Record<Exclude<PageId, InternalPageId>, string> = {
  groups: 'group',
  people: 'person',
  prayer: 'prayer point',
  settings: 'item',
}

function PlaceholderDrawer({
  alwaysTemporary,
  onClose,
  open,
  stacked,
}: Props) {
  const page = usePage()

  const canAdd = page ? pagesWithAddButton.includes(page.id) : false
  const itemName = (page ? itemNameMap[page.id] : undefined) || 'item'
  const addName = (page ? addNameMap[page.id] : undefined) || 'item'
  const aOrAn = 'aeiou'.includes(itemName.charAt(0).toLowerCase()) ? 'an' : 'a'

  const styles = useMemo(
    () => ({ opacity: 0.75 }),
    [],
  )

  return (
    <BaseDrawer
      alwaysTemporary={alwaysTemporary}
      hideTypeIcon
      onClose={onClose}
      open={open}
      stacked={stacked}
    >
      <Box
        display="flex"
        flexDirection="column"
        alignItems="center"
        justifyContent="center"
        flexGrow={1}
        sx={styles}
      >
        {page && (
          <LargeIcon icon={page.icon} />
        )}

        <Typography variant="h5" color="textSecondary" align="center">
          Select {aOrAn} {itemName} from the list<br />
          {canAdd ? (
            <span>
              or click the
              {' '}
              <InlineText
                fontSize="h5.fontSize"
                fontWeight={700}
              >
                +
              </InlineText>
              {' '}
              to add a new {addName}
            </span>
          ) : (
            <span>
              to view details
            </span>
          )}
        </Typography>
      </Box>
    </BaseDrawer>
  )
}

export default PlaceholderDrawer

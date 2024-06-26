import { memo } from 'react'
import { Box, BoxProps, IconButton, Typography } from '@mui/material'
import {
  getItemName,
  Item,
} from '../../state/items'
import MemberDisplay from '../MemberDisplay'
import GroupDisplay from '../GroupDisplay'
import { EditIcon } from '../Icons'
import Markdown from '../Markdown'

const Section = memo(
  ({ lessPadding, ...props }: BoxProps & { lessPadding?: boolean }) => (
    <Box py={lessPadding ? 1 : 2} {...props} />
  ),
)
Section.displayName = 'Section'

interface BaseProps {
  item: Item,
}

interface PropsWithEdit extends BaseProps {
  canEdit: true,
  onEdit: () => void,
}

interface PropsNoEdit extends BaseProps {
  canEdit?: false,
  onEdit?: () => void,
}

export type Props = PropsWithEdit | PropsNoEdit


function ItemReport({
  canEdit,
  item,
  onEdit,
}: Props) {
  return (
    <>
      <Box
        display="flex"
        alignItems="flex-start"
        justifyContent="space-between"
      >
        <Typography variant="h3">
          {getItemName(item)}
        </Typography>

        {canEdit && (
          <Box mt={0.5} ml={1}>
            <IconButton
              data-cy="edit-item-button"
              onClick={onEdit}
              size="large"
            >
              <EditIcon />
            </IconButton>
          </Box>
        )}
      </Box>

      {item.description && (
        <Typography color="textSecondary">
          {item.description}
        </Typography>
      )}

      {item.summary && (
        <>
          <Typography display="block" mt={1} fontWeight={500}>
            Notes
          </Typography>

          <Markdown>
            {item.summary}
          </Markdown>
        </>
      )}

      {item.type === 'person' && (
        <Section>
          <Typography variant="h4">
            Groups
          </Typography>

          <GroupDisplay
            itemId={item.id}
            editable={false}
          />
        </Section>
      )}

      {item.type === 'group' && (
        <Section>
          <Typography variant="h4">
            Members
          </Typography>

          <MemberDisplay
            editable={false}
            memberIds={item.members}
            onChange={() => {}}
          />
        </Section>
      )}
    </>
  )
}

export default ItemReport

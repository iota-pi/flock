import { PropsWithChildren, ReactNode } from 'react'
import { Box, Fab, Fade, LinearProgress, styled } from '@mui/material'
import { AddIcon } from '../Icons'
import TopBar, { MenuItemData } from '../layout/TopBar'
import { useAppSelector } from '../../store'
import { usePage } from '.'

interface BaseProps {
  noScrollContainer?: boolean,
}
interface FabProps {
  fab: true,
  onClickFab: () => void,
  fabIcon?: ReactNode,
  fabLabel: string,
}
interface NoFabProps {
  fab?: false,
  onClickFab?: never,
  fabIcon?: never,
  fabLabel?: never,
}
interface TopBarProps {
  allSelected?: boolean,
  onSelectAll?: () => void,
  menuItems?: MenuItemData[],
  showFilter?: boolean,
  showSort?: boolean,
  topBarTitle?: string,
  topBar: true,
}
interface NoTopBarProps {
  allSelected?: never,
  menuItems?: never,
  onSelectAll?: never,
  showFilter?: never,
  showSort?: never,
  topBar?: false,
  topBarTitle?: never,
}
type CombinedProps = BaseProps & (FabProps | NoFabProps) & (TopBarProps | NoTopBarProps)
type Props = PropsWithChildren<CombinedProps>
export type { Props as BasePageProps }


const ContentWithScroll = styled('div')(({ theme }) => ({
  position: 'relative',
  flexGrow: 1,
  paddingBottom: theme.spacing(8),
  overflowX: 'hidden',
  overflowY: 'auto',
}))
const ContentNoScroll = styled('div')({
  position: 'relative',
  flexGrow: 1,
  overflowX: 'hidden',
  overflowY: 'hidden',
})
const FabContainer = styled('div')(({ theme }) => ({
  position: 'absolute',
  right: theme.spacing(4),
  bottom: theme.spacing(3),
  zIndex: theme.zIndex.speedDial,
}))
const StyledProgress = styled(LinearProgress)({
  position: 'absolute',
  left: 0,
  right: 0,
  height: 2,
})


function BasePage({
  allSelected = false,
  children,
  fab,
  fabIcon,
  fabLabel,
  menuItems,
  onClickFab,
  onSelectAll,
  noScrollContainer,
  showFilter = false,
  showSort = false,
  topBar,
  topBarTitle,
}: Props) {
  const activeRequests = useAppSelector(state => state.ui.requests.active)
  const loading = activeRequests > 0

  const page = usePage()

  const ContentElement = noScrollContainer ? ContentNoScroll : ContentWithScroll

  return (
    <>
      {topBar && (
        <TopBar
          allSelected={allSelected}
          filterable={showFilter}
          menuItems={menuItems || []}
          onSelectAll={onSelectAll}
          sortable={showSort}
          title={topBarTitle}
        />
      )}

      <Box position="relative">
        <Fade in={loading}>
          <StyledProgress />
        </Fade>
      </Box>

      <ContentElement data-cy={`page-content-${page?.id}`}>
        {children}
      </ContentElement>

      {fab && (
        <FabContainer>
          <Fab
            aria-label={fabLabel}
            data-cy="fab"
            color="secondary"
            onClick={onClickFab}
          >
            {fabIcon || <AddIcon />}
          </Fab>
        </FabContainer>
      )}
    </>
  )
}

export default BasePage

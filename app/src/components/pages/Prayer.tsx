import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { Button, Divider, Grid, IconButton, Theme, Typography, useMediaQuery } from '@mui/material'
import { AutoSizer } from 'react-virtualized'
import { useItemMap, useItems, useMetadata } from '../../state/selectors'
import { isSameDay, useStringMemo } from '../../utils'
import { getLastPrayedFor, getNaturalPrayerGoal, getPrayerSchedule } from '../../utils/prayer'
import ItemList, { ItemListExtraElement } from '../ItemList'
import { Item } from '../../state/items'
import { useAppDispatch } from '../../store'
import { EditIcon } from '../Icons'
import GoalDialog from '../dialogs/GoalDialog'
import BasePage from './BasePage'
import { replaceActive } from '../../state/ui'
import PageContainer from '../PageContainer'
import { storeItems } from '../../api/Vault'


function isPrayedForToday(item: Item): boolean {
  return isSameDay(new Date(), new Date(getLastPrayedFor(item)))
}


function PrayerPage() {
  const dispatch = useAppDispatch()
  const items = useItems()
  const itemMap = useItemMap()

  const [showGoalDialog, setShowGoalDialog] = useState(false)

  const naturalGoal = useMemo(() => getNaturalPrayerGoal(items), [items])
  const [goal] = useMetadata('prayerGoal', naturalGoal)
  const [todaysGoal, setTodaysGoal] = useState(goal)
  useEffect(() => { setTodaysGoal(goal) }, [goal])

  const rawPrayerSchedule = useMemo(() => getPrayerSchedule(items), [items])
  const memoisedPrayerSchedule = useStringMemo(rawPrayerSchedule)
  const schedule = useMemo(
    () => memoisedPrayerSchedule.map(i => itemMap[i]),
    [itemMap, memoisedPrayerSchedule],
  )
  const visibleSchedule = useMemo(
    () => schedule.slice(0, todaysGoal),
    [todaysGoal, schedule],
  )

  const completed = useMemo(
    () => items.filter(isPrayedForToday).length,
    [items],
  )

  const recordPrayerFor = useCallback(
    (item: Item, toggle = false) => {
      let prayedFor = item.prayedFor
      if (isPrayedForToday(item)) {
        if (toggle) {
          const startOfDay = new Date()
          startOfDay.setHours(0, 0, 0, 0)
          prayedFor = prayedFor.filter(d => d < startOfDay.getTime())
        }
      } else {
        prayedFor = [...prayedFor, new Date().getTime()]
      }
      const newItem: Item = { ...item, prayedFor }
      storeItems(newItem)
    },
    [],
  )
  const handleClickPrayedFor = useCallback(
    (item: Item) => recordPrayerFor(item, true),
    [recordPrayerFor],
  )

  const handleClick = useCallback(
    (item: Item) => {
      const index = memoisedPrayerSchedule.indexOf(item.id)
      const endIndex = index < goal ? goal : memoisedPrayerSchedule.length
      const next = memoisedPrayerSchedule.slice(index + 1, endIndex)
      dispatch(replaceActive({ item: item.id, next, praying: true }))
    },
    [dispatch, goal, memoisedPrayerSchedule],
  )
  const handleEditGoal = useCallback(() => setShowGoalDialog(true), [])
  const handleCloseGoalDialog = useCallback(() => setShowGoalDialog(false), [])

  const handleClickShowMore = useCallback(
    () => { setTodaysGoal(g => g + 3) },
    [],
  )

  const xs = useMediaQuery<Theme>(theme => theme.breakpoints.down('sm'))
  const sm = useMediaQuery<Theme>(theme => theme.breakpoints.down('md'))
  const maxTags = sm ? (2 - +xs) : 3

  const extraElements: ItemListExtraElement[] = useMemo(
    () => [
      {
        content: (
          <Fragment key="heading-today">
            <PageContainer maxWidth="xl">
              <Grid container spacing={2}>
                <Grid
                  item
                  xs={12}
                  display="flex"
                  alignItems="center"
                >
                  <Typography>
                    {'Daily Goal: '}
                    {completed}
                    {' / '}
                    <Typography
                      color={goal < naturalGoal ? 'secondary' : 'textPrimary'}
                      component="span"
                    >
                      {goal}
                    </Typography>
                  </Typography>
                  <span>&nbsp;&nbsp;</span>

                  <IconButton size="medium" onClick={handleEditGoal}>
                    <EditIcon fontSize="small" />
                  </IconButton>
                </Grid>
              </Grid>
            </PageContainer>

            <Divider />
          </Fragment>
        ),
        height: 68.5,
        index: 0,
      },
      {
        content: (
          <Fragment key="show-more">
            <Divider />

            <Grid container spacing={2} padding={2}>
              <Grid
                item
                xs={12}
                display="flex"
                sx={{
                  justifyContent: 'center',
                }}
              >
                <Button
                  onClick={handleClickShowMore}
                  variant="outlined"
                >
                  Show More
                </Button>
              </Grid>
            </Grid>
          </Fragment>
        ),
        height: 68.5,
        index: -1,
      },
    ],
    [completed, goal, handleEditGoal, naturalGoal],
  )

  return (
    <BasePage noScrollContainer>
      <AutoSizer disableWidth>
        {({ height }) => (
          <ItemList
            checkboxes
            checkboxSide="right"
            extraElements={extraElements}
            getChecked={isPrayedForToday}
            getForceFade={isPrayedForToday}
            items={visibleSchedule}
            showTags={false}
            onClick={handleClick}
            onCheck={handleClickPrayedFor}
            noItemsText="No items in prayer schedule"
            showIcons
            viewHeight={height}
          />
        )}
      </AutoSizer>

      <GoalDialog
        naturalGoal={naturalGoal}
        onClose={handleCloseGoalDialog}
        open={showGoalDialog}
      />
    </BasePage>
  )
}

export default PrayerPage

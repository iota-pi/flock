import { Fragment, useCallback, useMemo, useState } from 'react'
import { Button, Divider, Grid, IconButton, Typography } from '@mui/material'
import { usePrayerSchedule } from '../../hooks/usePrayerSchedule'
import ItemList, { ItemListExtraElement } from '../ItemList'
import { Item } from '../../state/items'
import { useAppDispatch } from '../../store'
import { EditIcon } from '../Icons'
import GoalDialog from '../dialogs/GoalDialog'
import BasePage from './BasePage'
import { replaceActive } from '../../state/ui'
import PageContainer from '../PageContainer'


function PrayerPage() {
  const dispatch = useAppDispatch()
  const [showGoalDialog, setShowGoalDialog] = useState(false)

  const {
    completed,
    goal,
    isPrayedForToday,
    naturalGoal,
    recordPrayerFor,
    scheduleIds,
    showMore,
    visibleSchedule,
  } = usePrayerSchedule()

  const handleCheck = useCallback(
    (item: Item) => recordPrayerFor(item, true),
    [recordPrayerFor],
  )

  const handleClick = useCallback(
    (item: Item) => {
      const index = scheduleIds.indexOf(item.id)
      const endIndex = index < goal ? goal : scheduleIds.length
      const next = scheduleIds.slice(index + 1, endIndex)
      dispatch(replaceActive({ item: item.id, next, praying: true }))
    },
    [dispatch, goal, scheduleIds],
  )

  const handleEditGoal = useCallback(() => setShowGoalDialog(true), [])
  const handleCloseGoalDialog = useCallback(() => setShowGoalDialog(false), [])

  const extraElements: ItemListExtraElement[] = useMemo(
    () => [
      {
        content: (
          <Fragment key="heading-today">
            <PageContainer maxWidth="xl">
              <Grid container spacing={2}>
                <Grid item xs={12} display="flex" alignItems="center">
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

                  <IconButton
                    size="medium"
                    onClick={handleEditGoal}
                    sx={{ ml: 1 }}
                    data-cy="edit-goal"
                  >
                    <EditIcon fontSize="small" />
                  </IconButton>
                </Grid>
              </Grid>
            </PageContainer>
            <Divider />
          </Fragment>
        ),
        index: 0,
      },
      {
        content: (
          <Fragment key="show-more">
            <Divider />
            <Grid container spacing={2} padding={2}>
              <Grid item xs={12} display="flex" justifyContent="center">
                <Button onClick={showMore} variant="outlined">
                  Show More
                </Button>
              </Grid>
            </Grid>
          </Fragment>
        ),
        index: -1,
      },
    ],
    [completed, goal, handleEditGoal, naturalGoal, showMore],
  )

  return (
    <BasePage noScrollContainer>
      <ItemList
        checkboxes
        checkboxSide="right"
        extraElements={extraElements}
        getChecked={isPrayedForToday}
        getForceFade={isPrayedForToday}
        items={visibleSchedule}
        showTags={false}
        onClick={handleClick}
        onCheck={handleCheck}
        noItemsText="No items in prayer schedule"
        showIcons
      />

      <GoalDialog
        naturalGoal={naturalGoal}
        onClose={handleCloseGoalDialog}
        open={showGoalDialog}
      />
    </BasePage>
  )
}

export default PrayerPage

import { ReactNode, useCallback } from 'react'
import { useSwipeable } from 'react-swipeable'
import Box from '@mui/material/Box'
import { SxProps, Theme } from '@mui/material/styles'


type SwipeEvent = {
  deltaX: number
  deltaY: number
}

type SwipeableCarouselProps = {
  activeIndex: number
  children: ReactNode
  onBack: () => void
  onNext: () => void
  delta?: number
  transitionMs?: number
  wrapperSx?: SxProps<Theme>
}

export default function SwipeableCarousel({
  activeIndex,
  children,
  onBack,
  onNext,
  delta = 60,
  transitionMs = 300,
  wrapperSx,
}: SwipeableCarouselProps) {
  const handleSwiped = useCallback(
    ({ deltaX, deltaY }: SwipeEvent) => {
      if (Math.abs(deltaX) <= Math.abs(deltaY) * 1.5) return
      if (deltaX < 0) {
        onNext()
      } else {
        onBack()
      }
    },
    [onBack, onNext],
  )

  const swipeHandlers = useSwipeable({
    delta,
    onSwiped: handleSwiped,
    preventScrollOnSwipe: false,
    trackMouse: false,
    trackTouch: true,
  })

  return (
    <Box
      {...swipeHandlers}
      sx={{
        flexGrow: 1,
        overflow: 'hidden',
        width: '100%',
        ...wrapperSx,
      }}
    >
      <Box
        sx={{
          display: 'flex',
          height: '100%',
          transform: `translateX(-${activeIndex * 100}%)`,
          transition: `transform ${transitionMs}ms cubic-bezier(0.25, 0.8, 0.25, 1)`,
          width: '100%',
        }}
      >
        {children}
      </Box>
    </Box>
  )
}
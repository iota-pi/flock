import PrayerPageContent from './prayer/PrayerPageContent'
import usePrayerFlow from './prayer/usePrayerFlow'


function PrayerPage() {
  const flow = usePrayerFlow()
  return <PrayerPageContent flow={flow} />
}

export default PrayerPage

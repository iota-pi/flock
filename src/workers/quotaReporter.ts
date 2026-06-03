let quotaReporter: ((message: string) => void) | null = null

export function registerQuotaReporter(reporter: (message: string) => void) {
  quotaReporter = reporter
}

let lastReportedTime = 0
const REPORT_THROTTLE_MS = 10000 // 10 seconds

export function reportQuotaExceeded() {
  const now = Date.now()
  if (now - lastReportedTime < REPORT_THROTTLE_MS) {
    return
  }
  lastReportedTime = now
  if (quotaReporter) {
    quotaReporter(
      'Storage quota exceeded. Flock cannot save changes or synchronize, risking data loss. Please free up space and check your connection to sync.'
    )
  }
}

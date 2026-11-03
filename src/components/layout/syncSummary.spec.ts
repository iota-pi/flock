import { describeLastSynced, summariseSync } from './syncSummary'

const progress = (pendingItems: number, quarantinedItems = 0) => ({ pendingItems, quarantinedItems, lastSyncedAt: 0 })

describe('summariseSync', () => {
  it('shows just the icon when everything has synced', () => {
    expect(summariseSync('idle', progress(0))).toEqual({
      tone: 'synced',
      label: null,
      headline: 'All changes synced',
      details: [],
    })
  })

  it("doesn't claim everything synced before the worker has counted", () => {
    expect(summariseSync('connecting', null)).toMatchObject({ tone: 'unknown', label: null })
  })

  it('counts the items waiting to sync', () => {
    expect(summariseSync('idle', progress(3))).toMatchObject({
      tone: 'pending',
      label: '3 waiting',
      headline: '3 items waiting to sync',
    })
    expect(summariseSync('syncing', progress(1))).toMatchObject({
      headline: '1 item waiting to sync',
      details: ['Syncing now…'],
    })
  })

  it('treats syncing with nothing pending as synced, so the icon does not flicker', () => {
    expect(summariseSync('syncing', progress(0)).tone).toBe('synced')
  })

  it('shows offline with the number of items saved on this device', () => {
    expect(summariseSync('offline', progress(0))).toMatchObject({ tone: 'offline', label: 'Offline' })
    expect(summariseSync('offline', progress(2))).toMatchObject({
      label: 'Offline · 2',
      details: ["2 items saved on this device will sync when you're back online"],
    })
  })

  it('shows degraded sync as a sync issue', () => {
    expect(summariseSync('degraded', progress(4))).toMatchObject({
      tone: 'warning',
      label: 'Sync issue · 4',
      headline: 'Sync is having trouble',
    })
  })

  it('shows a stopped worker as an error', () => {
    expect(summariseSync('dead', progress(1))).toMatchObject({
      tone: 'error',
      label: 'Sync stopped',
      details: ["Changes to 1 item haven't synced. Reload to try again."],
    })
  })

  it('points to recovery for quarantined items', () => {
    const summary = summariseSync('idle', progress(1, 2))
    expect(summary).toMatchObject({ tone: 'warning', label: '2 not syncing', headline: "2 items can't sync" })
    expect(summary.details).toEqual([
      '1 item waiting to sync',
      "2 items couldn't sync and need attention (Settings → Corrupted data recovery)",
    ])
  })
})

describe('describeLastSynced', () => {
  const now = 10 * 60 * 60_000

  it('says when this device has never synced', () => {
    expect(describeLastSynced(null, now)).toBe('Not synced on this device yet')
  })

  it('says just now within a minute', () => {
    expect(describeLastSynced(now - 30_000, now)).toBe('Last synced just now')
  })

  it('gives the time since the last sync', () => {
    expect(describeLastSynced(now - 5 * 60_000, now)).toBe('Last synced 5 minutes ago')
    expect(describeLastSynced(now - 3 * 60 * 60_000, now)).toBe('Last synced 3 hours ago')
  })
})

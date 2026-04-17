import { describe, expect, it } from 'vitest'
import {
  getBlankPerson,
  type Item,
  type LocalChangeItem,
} from '../../../state/items'
import {
  applyPrayerToItem,
  prayerFlowReducer,
  type PrayerFlowState,
} from './prayerFlowReducer'

function createItem(id: string, overrides: Partial<LocalChangeItem<Item>> = {}): LocalChangeItem<Item> {
  return {
    ...getBlankPerson(id, false),
    ...overrides,
  } as LocalChangeItem<Item>
}

function createActiveState(item: LocalChangeItem<Item>): PrayerFlowState {
  return {
    current: { type: 'active', index: 0 },
    lastOverlay: { type: 'active', index: 0 },
    localItems: [item],
  }
}

describe('prayerFlowReducer', () => {
  it('edits the target item and marks it as locally changed when requested', () => {
    const item = createItem('item-1', { name: 'Before', hasLocalChanges: false })
    const state = createActiveState(item)

    const next = prayerFlowReducer(state, {
      type: 'edit-item',
      index: 0,
      changes: { name: 'After' },
      markLocalChange: true,
    })

    expect(next.localItems[0]?.name).toBe('After')
    expect(next.localItems[0]?.hasLocalChanges).toBe(true)
  })

  it('replaces the target item with a semantic replace action', () => {
    const item = createItem('item-1')
    const replacement = createItem('item-1', { name: 'Updated' })
    const state = createActiveState(item)

    const next = prayerFlowReducer(state, {
      type: 'replace-item',
      index: 0,
      item: replacement,
    })

    expect(next.localItems[0]).toEqual(replacement)
  })

  it('records prayer only once per calendar day', () => {
    const existingPrayer = new Date(2026, 3, 17, 10, 0, 0, 0).getTime()
    const sameDayPrayer = new Date(2026, 3, 17, 18, 0, 0, 0).getTime()
    const item = createItem('item-1', { prayedFor: [existingPrayer] })
    const state = createActiveState(item)

    const next = prayerFlowReducer(state, {
      type: 'record-prayer',
      index: 0,
      timestamp: sameDayPrayer,
    })

    expect(next.localItems[0]?.prayedFor).toEqual([existingPrayer])
  })

  it('records prayer and marks item as locally changed when no same-day entry exists', () => {
    const prayerTime = new Date('2026-04-18T10:00:00.000Z').getTime()
    const item = createItem('item-1', { prayedFor: [], hasLocalChanges: false })
    const state = createActiveState(item)

    const next = prayerFlowReducer(state, {
      type: 'record-prayer',
      index: 0,
      timestamp: prayerTime,
    })

    expect(next.localItems[0]?.prayedFor).toEqual([prayerTime])
    expect(next.localItems[0]?.hasLocalChanges).toBe(true)
  })

  it('clears local items via semantic clear action', () => {
    const state = createActiveState(createItem('item-1'))

    const next = prayerFlowReducer(state, { type: 'clear-local-items' })

    expect(next.localItems).toEqual([])
  })
})

describe('applyPrayerToItem', () => {
  it('returns unchanged item when already prayed on the same day', () => {
    const existingPrayer = new Date(2026, 3, 19, 9, 0, 0, 0).getTime()
    const nextPrayer = new Date(2026, 3, 19, 20, 0, 0, 0).getTime()
    const item = createItem('item-1', { prayedFor: [existingPrayer] })

    const result = applyPrayerToItem(item, nextPrayer)

    expect(result.addedPrayer).toBe(false)
    expect(result.item).toBe(item)
  })
})

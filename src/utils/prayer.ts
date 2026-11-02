import { frequencyToDays, frequencyToMilliseconds } from './frequencies'
import { getStartOfDay, isSameDay } from './index'
import { compareItems, filterArchived, type Item } from '../state/items'
import type { GroupItem } from '../shared/schemas/items'
import type { ItemId } from '@vault/shared'

const ONE_DAY_IN_MS = 24 * 60 * 60 * 1000

type PrayerCandidate = {
  id: ItemId
  groupId: ItemId
  groupShiftQuantum: number
  next: number
  stableOrder: number
}

/** The candidates that share a group, in the order they're picked */
type PrayerBucket = {
  groupShiftQuantum: number
  candidates: PrayerCandidate[]
  selectedCount: number
}

/** A bucket's next candidate and when it's effectively due */
type HeapEntry = {
  bucket: PrayerBucket
  effectiveNext: number
  stableOrder: number
}

function isBefore(left: HeapEntry, right: HeapEntry): boolean {
  return left.effectiveNext < right.effectiveNext
    || (left.effectiveNext === right.effectiveNext && left.stableOrder < right.stableOrder)
}

function swap(heap: HeapEntry[], i: number, j: number): void {
  const temporary = heap[i]
  heap[i] = heap[j]
  heap[j] = temporary
}

// Bucket heads sit in a binary min-heap, so building the schedule stays O(n log n) however many buckets there are

function pushEntry(heap: HeapEntry[], entry: HeapEntry): void {
  heap.push(entry)
  let index = heap.length - 1
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2)
    if (!isBefore(heap[index], heap[parent])) {
      break
    }
    swap(heap, index, parent)
    index = parent
  }
}

function popEntry(heap: HeapEntry[]): HeapEntry {
  const top = heap[0]
  const last = heap.pop()!
  if (heap.length === 0) {
    return top
  }

  heap[0] = last
  let index = 0
  for (;;) {
    const left = (index * 2) + 1
    const right = left + 1
    let smallest = index
    if (left < heap.length && isBefore(heap[left], heap[smallest])) {
      smallest = left
    }
    if (right < heap.length && isBefore(heap[right], heap[smallest])) {
      smallest = right
    }
    if (smallest === index) {
      return top
    }
    swap(heap, index, smallest)
    index = smallest
  }
}

function getHeadEntry(bucket: PrayerBucket, now: number): HeapEntry | null {
  const candidate = bucket.candidates[bucket.selectedCount]
  if (!candidate) {
    return null
  }

  return {
    bucket,
    effectiveNext: Math.max(candidate.next, now) + bucket.selectedCount * bucket.groupShiftQuantum,
    stableOrder: candidate.stableOrder,
  }
}

function getActiveMemberCount(group: GroupItem, activeIdSet: Set<ItemId>): number {
  return group.members.filter(id => activeIdSet.has(id)).length
}

function shouldPreferGroup(current: GroupItem, best: GroupItem, activeIdSet: Set<ItemId>): boolean {
  const bestFrequency = frequencyToMilliseconds(best.memberPrayerFrequency)
  const currentFrequency = frequencyToMilliseconds(current.memberPrayerFrequency)

  if (currentFrequency < bestFrequency) {
    return true
  }

  if (currentFrequency === bestFrequency) {
    return getActiveMemberCount(current, activeIdSet) < getActiveMemberCount(best, activeIdSet)
  }

  return false
}

function getGroups(items: Item[]): GroupItem[] {
  return items.filter((i): i is GroupItem => i.type === 'group')
}

export function buildPrayerFreqMap(items: Item[]): Map<ItemId, number> {
  const groups = getGroups(items)
  const activeIdSet = new Set(items.map(i => i.id))

  const map: Map<ItemId, number> = new Map()

  // Initialise map with each person's or topic's own set frequency
  for (const it of items) {
    if ((it.type === 'person' || it.type === 'topic') && it.prayerFrequency && it.prayerFrequency !== 'none') {
      map.set(it.id, frequencyToDays(it.prayerFrequency))
    }
  }

  // Iterate through groups and apply memberPrayerFrequency to members
  for (const g of groups) {
    if (g.memberPrayerFrequency && g.memberPrayerFrequency !== 'none') {
      const groupDays = frequencyToDays(g.memberPrayerFrequency)
      const activeMemberCount = getActiveMemberCount(g, activeIdSet)
      const effectiveGroupDays = (
        g.memberPrayerTarget === 'one'
          ? groupDays * activeMemberCount
          : groupDays
      )
      for (const memberId of g.members) {
        if (!activeIdSet.has(memberId)) {
          continue
        }
        const currDays = map.get(memberId)
        if (currDays === undefined) {
          map.set(memberId, effectiveGroupDays)
        } else if (effectiveGroupDays < currDays) {
          map.set(memberId, effectiveGroupDays)
        }
      }
    }
  }

  return map
}

export function getActiveItems(
  items: Item[],
  frequencies?: Map<ItemId, number>,
): Item[] {
  const freqMap = frequencies ?? buildPrayerFreqMap(items)
  return items.filter(i => freqMap.has(i.id)).sort(compareItems)
}

export function getLastPrayedFor(
  item: Item,
  excludeToday = false,
) {
  const prayedFor = item.prayedFor
  if (prayedFor.length === 0) {
    return 0
  }

  if (!excludeToday) {
    return prayedFor[prayedFor.length - 1] || 0
  }

  const startOfTodayMs = getStartOfDay().getTime()
  const endOfTodayMs = startOfTodayMs + ONE_DAY_IN_MS

  for (let index = prayedFor.length - 1; index >= 0; index -= 1) {
    const timestamp = prayedFor[index] || 0
    if (timestamp < startOfTodayMs || timestamp >= endOfTodayMs) {
      return timestamp
    }
  }

  return 0
}

/** Whether the item was last prayed for on the same day as `today` */
export function isPrayedForToday(item: Item, today = new Date()): boolean {
  return isSameDay(today, new Date(getLastPrayedFor(item)))
}

/** The item's prayer times with today's removed if it was prayed for today, or with now added if not */
export function togglePrayedForToday(item: Item): number[] {
  if (isPrayedForToday(item)) {
    const startOfToday = getStartOfDay().getTime()
    return item.prayedFor.filter(time => time < startOfToday)
  }
  return [...item.prayedFor, Date.now()]
}

export function getPrayerSchedule(items: Item[]): ItemId[] {
  const unarchived = filterArchived(items)
  const freqMap = buildPrayerFreqMap(unarchived)
  const activeItems = getActiveItems(unarchived, freqMap)
  const groups = getGroups(unarchived)
  const activeIdSet = new Set(unarchived.map(i => i.id))

  const bestGroupByMemberId = new Map<ItemId, GroupItem>()
  for (const group of groups) {
    for (const memberId of group.members) {
      if (!activeIdSet.has(memberId)) {
        continue
      }
      const currentBest = bestGroupByMemberId.get(memberId)
      if (!currentBest || shouldPreferGroup(group, currentBest, activeIdSet)) {
        bestGroupByMemberId.set(memberId, group)
      }
    }
  }

  const candidates: PrayerCandidate[] = activeItems.map((item, stableOrder) => {
    const last = getLastPrayedFor(item, true)
    const interval = frequencyToMilliseconds(freqMap.get(item.id)!)

    let groupId = item.id
    let groupShiftQuantum = 0

    const bestGroup = bestGroupByMemberId.get(item.id)
    if (bestGroup) {
      groupId = bestGroup.id
      const memberCount = getActiveMemberCount(bestGroup, activeIdSet)
      const groupFreqMs = frequencyToMilliseconds(bestGroup.memberPrayerFrequency)

      if (bestGroup.memberPrayerTarget === 'one') {
        groupShiftQuantum = groupFreqMs
      } else {
        groupShiftQuantum = groupFreqMs / (memberCount || 1)
      }
    }

    return {
      id: item.id,
      groupId,
      groupShiftQuantum,
      next: last + interval,
      stableOrder,
    }
  })

  const now = Date.now()
  const buckets = new Map<ItemId, PrayerBucket>()
  for (const candidate of candidates) {
    const bucket = buckets.get(candidate.groupId)
    if (bucket) {
      bucket.candidates.push(candidate)
    } else {
      buckets.set(candidate.groupId, {
        groupShiftQuantum: candidate.groupShiftQuantum,
        candidates: [candidate],
        selectedCount: 0,
      })
    }
  }

  const heap: HeapEntry[] = []
  for (const bucket of buckets.values()) {
    bucket.candidates.sort((left, right) => (
      (left.next - right.next)
      || (left.stableOrder - right.stableOrder)
    ))
    pushEntry(heap, getHeadEntry(bucket, now)!)
  }

  const schedule: ItemId[] = []
  while (heap.length > 0) {
    const { bucket } = popEntry(heap)
    schedule.push(bucket.candidates[bucket.selectedCount].id)
    bucket.selectedCount += 1

    const nextEntry = getHeadEntry(bucket, now)
    if (nextEntry) {
      pushEntry(heap, nextEntry)
    }
  }

  return schedule
}

export function getNaturalPrayerGoal(items: Item[]) {
  const unarchived = filterArchived(items)
  const freqMap = buildPrayerFreqMap(unarchived)
  const activeItems = getActiveItems(unarchived, freqMap)

  let sum = 0
  for (const item of activeItems) {
    const days = freqMap.get(item.id)!
    sum += 1 / days
  }

  return Math.ceil(sum)
}

export function isPrayerCompletedForToday(
  items: Item[],
  prayerGoal?: number,
  today: Date = new Date(),
): boolean {
  const unarchived = filterArchived(items).filter(item => !item.deleted)
  if (unarchived.length === 0) {
    return false
  }

  const prayedToday = (item: Item) => isPrayedForToday(item, today)

  const completed = unarchived.filter(prayedToday).length
  if (completed === 0) {
    return false
  }

  const goal = prayerGoal ?? getNaturalPrayerGoal(unarchived)

  const scheduleIds = getPrayerSchedule(unarchived)
  if (scheduleIds.length === 0) {
    return false
  }

  // The schedule only holds ids from unarchived, so every lookup finds its item
  const itemMap = new Map(unarchived.map(item => [item.id, item]))
  const allVisiblePrayed = scheduleIds
    .slice(0, Math.max(1, goal))
    .every(id => prayedToday(itemMap.get(id)!))

  return allVisiblePrayed || (goal > 0 && completed >= goal)
}

import { frequencyToDays, frequencyToMilliseconds } from './frequencies'
import { compareItems, filterArchived, Item } from '../state/items'
import type { GroupItem, ItemId } from '../shared/schemas/items'

const ONE_DAY_IN_MS = 24 * 60 * 60 * 1000

type PrayerCandidate = {
  id: ItemId
  groupId: ItemId
  groupShiftQuantum: number
  next: number
  stableOrder: number
}

type PrayerBucket = {
  groupId: ItemId
  groupShiftQuantum: number
  selectedCount: number
  cursor: number
  candidates: PrayerCandidate[]
}

type PrayerBucketHeapEntry = {
  groupId: ItemId
  effectiveNext: number
  stableOrder: number
}

function comparePrayerBucketHeapEntries(
  left: PrayerBucketHeapEntry,
  right: PrayerBucketHeapEntry,
): number {
  if (left.effectiveNext !== right.effectiveNext) {
    return left.effectiveNext - right.effectiveNext
  }

  return left.stableOrder - right.stableOrder
}

function swapHeapEntries(
  heap: PrayerBucketHeapEntry[],
  leftIndex: number,
  rightIndex: number,
): void {
  const temporary = heap[leftIndex]
  heap[leftIndex] = heap[rightIndex]
  heap[rightIndex] = temporary
}

function siftHeapUp(heap: PrayerBucketHeapEntry[], startIndex: number): void {
  let index = startIndex

  while (index > 0) {
    const parentIndex = Math.floor((index - 1) / 2)
    if (comparePrayerBucketHeapEntries(heap[index], heap[parentIndex]) >= 0) {
      break
    }

    swapHeapEntries(heap, index, parentIndex)
    index = parentIndex
  }
}

function siftHeapDown(heap: PrayerBucketHeapEntry[], startIndex: number): void {
  let index = startIndex

  while (index < heap.length) {
    const leftChildIndex = (index * 2) + 1
    const rightChildIndex = leftChildIndex + 1

    let smallestIndex = index
    if (
      leftChildIndex < heap.length
      && comparePrayerBucketHeapEntries(heap[leftChildIndex], heap[smallestIndex]) < 0
    ) {
      smallestIndex = leftChildIndex
    }

    if (
      rightChildIndex < heap.length
      && comparePrayerBucketHeapEntries(heap[rightChildIndex], heap[smallestIndex]) < 0
    ) {
      smallestIndex = rightChildIndex
    }

    if (smallestIndex === index) {
      break
    }

    swapHeapEntries(heap, index, smallestIndex)
    index = smallestIndex
  }
}

function pushPrayerBucketEntry(heap: PrayerBucketHeapEntry[], entry: PrayerBucketHeapEntry): void {
  heap.push(entry)
  siftHeapUp(heap, heap.length - 1)
}

function popPrayerBucketEntry(heap: PrayerBucketHeapEntry[]): PrayerBucketHeapEntry | undefined {
  if (heap.length === 0) {
    return undefined
  }

  if (heap.length === 1) {
    return heap.pop()
  }

  const top = heap[0]
  const tail = heap.pop()
  if (!tail) {
    return top
  }

  heap[0] = tail
  siftHeapDown(heap, 0)
  return top
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

function getBucketHeadEntry(bucket: PrayerBucket, now: number): PrayerBucketHeapEntry | null {
  const candidate = bucket.candidates[bucket.cursor]
  if (!candidate) {
    return null
  }

  const shift = bucket.selectedCount * bucket.groupShiftQuantum
  const effectiveBase = Math.max(candidate.next, now)

  return {
    groupId: bucket.groupId,
    effectiveNext: effectiveBase + shift,
    stableOrder: candidate.stableOrder,
  }
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
      const activeMemberCount = g.members.filter(memberId => activeIdSet.has(memberId)).length
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

  const startOfToday = new Date()
  startOfToday.setHours(0, 0, 0, 0)
  const startOfTodayMs = startOfToday.getTime()
  const endOfTodayMs = startOfTodayMs + ONE_DAY_IN_MS

  for (let index = prayedFor.length - 1; index >= 0; index -= 1) {
    const timestamp = prayedFor[index] || 0
    if (timestamp < startOfTodayMs || timestamp >= endOfTodayMs) {
      return timestamp
    }
  }

  return 0
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

  const schedule: ItemId[] = []
  const now = Date.now()

  const bucketByGroupId = new Map<ItemId, PrayerBucket>()
  for (const candidate of candidates) {
    const existing = bucketByGroupId.get(candidate.groupId)
    if (existing) {
      existing.candidates.push(candidate)
      continue
    }

    bucketByGroupId.set(candidate.groupId, {
      groupId: candidate.groupId,
      groupShiftQuantum: candidate.groupShiftQuantum,
      selectedCount: 0,
      cursor: 0,
      candidates: [candidate],
    })
  }

  const bucketHeap: PrayerBucketHeapEntry[] = []
  for (const bucket of bucketByGroupId.values()) {
    bucket.candidates.sort((left, right) => (
      (left.next - right.next)
      || (left.stableOrder - right.stableOrder)
    ))

    const headEntry = getBucketHeadEntry(bucket, now)
    if (headEntry) {
      pushPrayerBucketEntry(bucketHeap, headEntry)
    }
  }

  while (bucketHeap.length > 0) {
    const topBucketEntry = popPrayerBucketEntry(bucketHeap)
    if (!topBucketEntry) {
      break
    }

    const bucket = bucketByGroupId.get(topBucketEntry.groupId)
    if (!bucket) {
      continue
    }

    const topCandidate = bucket.candidates[bucket.cursor]
    if (!topCandidate) {
      continue
    }

    schedule.push(topCandidate.id)
    bucket.cursor += 1
    bucket.selectedCount += 1

    const nextHeadEntry = getBucketHeadEntry(bucket, now)
    if (nextHeadEntry) {
      pushPrayerBucketEntry(bucketHeap, nextHeadEntry)
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

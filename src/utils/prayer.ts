import { frequencyToDays, frequencyToMilliseconds } from './frequencies'
import { compareItems, filterArchived, Item } from '../state/items'
import type { GroupItem } from '../shared/schemas/items'

const ONE_DAY_IN_MS = 24 * 60 * 60 * 1000

type PrayerCandidate = {
  id: string
  groupId: string
  groupShiftQuantum: number
  next: number
  stableOrder: number
}

type PrayerBucket = {
  groupId: string
  groupShiftQuantum: number
  selectedCount: number
  cursor: number
  candidates: PrayerCandidate[]
}

type PrayerBucketHeapEntry = {
  groupId: string
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

function shouldPreferGroup(current: GroupItem, best: GroupItem): boolean {
  const bestFrequency = frequencyToMilliseconds(best.memberPrayerFrequency)
  const currentFrequency = frequencyToMilliseconds(current.memberPrayerFrequency)

  if (currentFrequency < bestFrequency) {
    return true
  }

  if (currentFrequency === bestFrequency) {
    return current.members.length < best.members.length
  }

  return false
}

function getBucketHeadEntry(bucket: PrayerBucket): PrayerBucketHeapEntry | null {
  const candidate = bucket.candidates[bucket.cursor]
  if (!candidate) {
    return null
  }

  return {
    groupId: bucket.groupId,
    effectiveNext: candidate.next + (bucket.selectedCount * bucket.groupShiftQuantum),
    stableOrder: candidate.stableOrder,
  }
}

function getGroups(items: Item[]): GroupItem[] {
  return items.filter((i): i is GroupItem => i.type === 'group')
}

export function buildPrayerFreqMap(items: Item[]): Map<string, number> {
  const groups = getGroups(items)

  const map: Map<string, number> = new Map()

  // Initialise map with each person's own set frequency
  for (const it of items) {
    if (it.type === 'person' && it.prayerFrequency && it.prayerFrequency !== 'none') {
      map.set(it.id, frequencyToDays(it.prayerFrequency))
    }
  }

  // Iterate through groups and apply memberPrayerFrequency to members
  for (const g of groups) {
    if (g.memberPrayerFrequency && g.memberPrayerFrequency !== 'none') {
      const groupDays = frequencyToDays(g.memberPrayerFrequency)
      const effectiveGroupDays = (
        g.memberPrayerTarget === 'one'
          ? groupDays * g.members.length
          : groupDays
      )
      for (const memberId of g.members) {
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
  frequencies?: Map<string, number>,
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

export function getPrayerSchedule(items: Item[]): string[] {
  const unarchived = filterArchived(items)
  const freqMap = buildPrayerFreqMap(unarchived)
  const activeItems = getActiveItems(unarchived, freqMap)
  const groups = getGroups(unarchived)

  const bestGroupByMemberId = new Map<string, GroupItem>()
  for (const group of groups) {
    for (const memberId of group.members) {
      const currentBest = bestGroupByMemberId.get(memberId)
      if (!currentBest || shouldPreferGroup(group, currentBest)) {
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
      const memberCount = bestGroup.members.length || 1
      const groupFreqMs = frequencyToMilliseconds(bestGroup.memberPrayerFrequency)

      if (bestGroup.memberPrayerTarget === 'one') {
        groupShiftQuantum = groupFreqMs
      } else {
        groupShiftQuantum = groupFreqMs / memberCount
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

  const schedule: string[] = []

  const bucketByGroupId = new Map<string, PrayerBucket>()
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

    const headEntry = getBucketHeadEntry(bucket)
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

    const nextHeadEntry = getBucketHeadEntry(bucket)
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

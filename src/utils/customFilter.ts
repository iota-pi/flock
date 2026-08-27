import { isSameDay } from '.'
import { getItemName, Item } from '../state/items'
import { Frequency, frequencyToDays } from './frequencies'
import { getLastPrayedFor } from './prayer'
import type { GroupLookupData, ItemType } from '../shared/itemTypes'

type FilterFieldType = (
  'string' | 'number' | 'boolean' | 'date' | 'frequency' | 'group'
)
type FilterBaseOperatorName = (
  'is' |
  'contains' |
  'greater'
)
export type FilterOperatorName = (
  FilterBaseOperatorName |
  'isnot' |
  'notcontains' |
  'lessthan' |
  'before' |
  'after'
)
interface FilterOperator {
  baseOperator: FilterBaseOperatorName,
  inverse: boolean,
  name: string,
}
export const FILTER_OPERATORS_MAP: Record<FilterOperatorName, FilterOperator> = {
  is: { name: 'Is', baseOperator: 'is', inverse: false },
  isnot: { name: 'Is not', baseOperator: 'is', inverse: true },
  contains: { name: 'Contains', baseOperator: 'contains', inverse: false },
  notcontains: { name: 'Does not contain', baseOperator: 'contains', inverse: true },
  lessthan: { name: 'Less Than', baseOperator: 'greater', inverse: true },
  greater: { name: 'Greater', baseOperator: 'greater', inverse: false },
  before: { name: 'Before', baseOperator: 'greater', inverse: true },
  after: { name: 'After', baseOperator: 'greater', inverse: false },
}

export type FilterCriterionType = (
  | 'created'
  | 'description'
  | 'groups'
  | 'lastPrayedFor'
  | 'name'
  | 'prayerFrequency'
)
interface FilterCriterionDisplayData {
  name: string,
  dataType: FilterFieldType,
  operators: FilterOperatorName[],
}
export interface FilterCriterion {
  baseOperator: FilterBaseOperatorName,
  inverse: boolean,
  operator: FilterOperatorName,
  type: FilterCriterionType,
  value: string | number | boolean,
}
export const FILTER_CRITERIA_DISPLAY_MAP: (
  Record<FilterCriterionType, FilterCriterionDisplayData>
) = {
  created: {
    dataType: 'date',
    name: 'Date created',
    operators: ['is', 'isnot', 'after', 'before'],
  },
  description: {
    dataType: 'string',
    name: 'Description',
    operators: ['contains', 'notcontains', 'is', 'isnot'],
  },
  groups: {
    dataType: 'group',
    name: 'Group membership',
    operators: ['contains', 'notcontains'],
  },
  lastPrayedFor: {
    dataType: 'date',
    name: 'Last prayed for',
    operators: ['is', 'isnot', 'after', 'before'],
  },
  name: {
    dataType: 'string',
    name: 'Name',
    operators: ['contains', 'notcontains', 'is', 'isnot'],
  },
  prayerFrequency: {
    dataType: 'frequency',
    name: 'Prayer Frequency',
    operators: ['is', 'isnot', 'greater', 'lessthan'],
  },
}
const FILTER_CRITERIA_ORDER: FilterCriterionType[] = [
  'name',
  'description',
  'prayerFrequency',
  'created',
  'lastPrayedFor',
  'groups',
]
export const FILTER_CRITERIA_DISPLAY = (
  FILTER_CRITERIA_ORDER.map(fc => fc)
)

export function getAvailableFilterCriteria(itemType?: ItemType): FilterCriterionType[] {
  if (itemType === 'group') {
    return FILTER_CRITERIA_ORDER.filter(fc => fc !== 'groups')
  }
  return FILTER_CRITERIA_ORDER
}

export const DEFAULT_ADDITIONAL_FILTER_CRITERION: FilterCriterion = {
  type: 'name',
  baseOperator: 'contains',
  inverse: false,
  operator: 'contains',
  value: '',
}

export const DEFAULT_FILTER_CRITERIA: FilterCriterion[] = []

const criterionEvaluators: Record<
  FilterCriterionType,
  (item: Item, criterion: FilterCriterion, groupsByMemberId?: ReadonlyMap<string, GroupLookupData>) => boolean
> = {
  created: (item, criterion) => {
    if (criterion.baseOperator === 'is') {
      return isSameDay(new Date(item.created), new Date(criterion.value as number))
    }
    if (criterion.baseOperator === 'greater') {
      return item.created > (criterion.value as number)
    }
    return true
  },
  description: (item, criterion) => {
    const description = item.description.toLocaleLowerCase()
    const value = (criterion.value as string).toLocaleLowerCase()
    if (criterion.baseOperator === 'is') {
      return description === value
    }
    if (criterion.baseOperator === 'contains') {
      return description.includes(value)
    }
    return true
  },
  groups: (item, criterion, groupsByMemberId) => {
    const groupData = groupsByMemberId?.get(item.id)
    const groupNames = groupData?.groupNames ?? []
    const groupIds = groupData?.groupIds ?? []
    const value = (criterion.value as string).toLocaleLowerCase()
    if (criterion.baseOperator === 'contains') {
      if (!value) {
        return true
      }
      return (
        groupIds.some(gId => gId.toLocaleLowerCase() === value) ||
        groupNames.some(gName => gName.toLocaleLowerCase().includes(value))
      )
    }
    return true
  },
  lastPrayedFor: (item, criterion) => {
    const lastPrayer = getLastPrayedFor(item)
    const value = criterion.value as number
    if (criterion.baseOperator === 'is') {
      return isSameDay(new Date(lastPrayer), new Date(value))
    }
    if (criterion.baseOperator === 'greater') {
      return item.created > value
    }
    return true
  },
  name: (item, criterion) => {
    const name = getItemName(item).toLocaleLowerCase()
    const value = (criterion.value as string).toLocaleLowerCase()
    if (criterion.baseOperator === 'is') {
      return name === value
    }
    if (criterion.baseOperator === 'contains') {
      return name.includes(value)
    }
    return true
  },
  prayerFrequency: (item, criterion) => {
    if (criterion.baseOperator === 'is') {
      return item.prayerFrequency === criterion.value
    }
    if (criterion.baseOperator === 'greater') {
      const daysItem = frequencyToDays(item.prayerFrequency)
      const daysCriterion = frequencyToDays(criterion.value as Frequency)
      return daysItem < daysCriterion
    }
    return true
  },
}

export function filterItems<T extends Item>(
  items: T[],
  criteria: FilterCriterion[],
  groupsByMemberId?: ReadonlyMap<string, GroupLookupData>,
) {
  if (!criteria.length) {
    return items
  }

  const compiledCriteria = criteria.map(criterion => {
    const evaluator = criterionEvaluators[criterion.type]
    return (item: Item) => {
      const baseResult = evaluator ? evaluator(item, criterion, groupsByMemberId) : true
      return criterion.inverse ? !baseResult : baseResult
    }
  })

  const filteredItems = items.filter(item => (
    compiledCriteria.every(predicate => predicate(item))
  ))
  return filteredItems.length < items.length ? filteredItems : items
}

export function getBaseValue(field: FilterCriterionType): FilterCriterion['value'] {
  const dataType = FILTER_CRITERIA_DISPLAY_MAP[field].dataType
  if (dataType === 'boolean') return false
  if (dataType === 'date') return new Date().getTime()
  if (dataType === 'number') return 0
  if (dataType === 'string') return ''
  if (dataType === 'frequency') return 'monthly' as Frequency
  if (dataType === 'group') return ''

  throw new Error(`Unknown data type ${dataType}`)
}

export function isDefaultNoArchivedItemsFilter(criterion: FilterCriterion): boolean {
  return (
    (criterion as unknown as { type: string }).type === 'archived'
    && criterion.baseOperator === 'is'
    && criterion.inverse === false
    && criterion.operator === 'is'
    && (criterion.value === false || criterion.value === 'false')
  )
}

export function isPracticalFilterCriterion(criterion: FilterCriterion): boolean {
  if (isDefaultNoArchivedItemsFilter(criterion)) {
    return false
  }

  if (criterion.operator === 'contains' && criterion.value === '') {
    return false
  }

  return true
}

import { isSameDay } from '.'
import { getItemName, Item } from '../state/items'
import { FREQUENCIES_TO_DAYS, Frequency } from './frequencies'
import { getLastPrayedFor } from './prayer'

export type FilterFieldType = (
  'string' | 'number' | 'boolean' | 'date' | 'frequency'
)
export type FilterBaseOperatorName = (
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
export interface FilterOperator {
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
  | 'lastPrayedFor'
  | 'name'
  | 'prayerFrequency'
)
export interface FilterCriterionDisplayData {
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
export const FILTER_CRITERIA_ORDER: FilterCriterionType[] = [
  'name',
  'description',
  'prayerFrequency',
  'created',
  'lastPrayedFor',
]
export const FILTER_CRITERIA_DISPLAY = (
  FILTER_CRITERIA_ORDER.map(fc => fc)
)

export const DEFAULT_FILTER_CRITERIA: FilterCriterion[] = [
  {
    type: 'name',
    baseOperator: 'contains',
    inverse: false,
    operator: 'contains',
    value: '',
  },
]

export function filterItems<T extends Item>(
  items: T[],
  criteria: FilterCriterion[],
) {
  const funcs: Record<FilterCriterionType, (item: Item, criterion: FilterCriterion) => boolean> = {
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
        const daysItem = FREQUENCIES_TO_DAYS[item.prayerFrequency]
        const daysCriterion = FREQUENCIES_TO_DAYS[criterion.value as Frequency]
        return daysItem < daysCriterion
      }
      return true
    },
  }

  if (!criteria.length) {
    return items
  }

  const filteredItems = items.filter(item => {
    for (const criterion of criteria) {
      const func = funcs[criterion.type]
      const baseResult = func(item, criterion)
      const result = criterion.inverse ? !baseResult : baseResult
      if (!result) {
        return false
      }
    }
    return true
  })
  return filteredItems.length < items.length ? filteredItems : items
}

export function getBaseValue(field: FilterCriterionType): FilterCriterion['value'] {
  const dataType = FILTER_CRITERIA_DISPLAY_MAP[field].dataType
  if (dataType === 'boolean') return false
  if (dataType === 'date') return new Date().getTime()
  if (dataType === 'number') return 0
  if (dataType === 'string') return ''
  if (dataType === 'frequency') return 'monthly' as Frequency

  throw new Error(`Unknown data type ${dataType}`)
}

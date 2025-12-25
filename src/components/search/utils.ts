import { compareItems, getItemName } from '../../state/items'
import { AnySearchable, AnySearchableData, SEARCHABLE_BASE_SORT_ORDER } from './types'

export function getSearchableDataId(s: AnySearchableData): string {
  return typeof s === 'string' ? s : s.id
}

export function isSearchableStandardItem(s: AnySearchable): s is AnySearchable & { create?: false, data: object } {
  return s.type === 'person' || s.type === 'group'
}

export function sortSearchables(a: AnySearchable, b: AnySearchable): number {
  const typeIndexA = SEARCHABLE_BASE_SORT_ORDER.indexOf(a.type)
  const typeIndexB = SEARCHABLE_BASE_SORT_ORDER.indexOf(b.type)
  if (typeIndexA - typeIndexB) {
    return typeIndexA - typeIndexB
  }
  if (isSearchableStandardItem(a) && isSearchableStandardItem(b)) {
    return compareItems(a.data, b.data)
  }
  return +(a.id > b.id) - +(a.id < b.id)
}

export function getName(option: AnySearchable) {
  if (option.create) {
    return getItemName(option.default)
  }
  return getItemName(option.data)
}

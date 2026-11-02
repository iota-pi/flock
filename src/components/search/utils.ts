import { compareItems, compareItemTypes, getItemName } from 'src/state/items'
import type { AnySearchable } from './types'


export function isSearchableStandardItem(s: AnySearchable): s is AnySearchable & { create?: false, data: object } {
  return !s.create
}

export function sortSearchables(a: AnySearchable, b: AnySearchable): number {
  return (
    compareItemTypes(a.type, b.type)
    || (isSearchableStandardItem(a) && isSearchableStandardItem(b) ? compareItems(a.data, b.data) : 0)
    || +(a.id > b.id) - +(a.id < b.id)
  )
}

export function getName(option: AnySearchable) {
  if (option.create) {
    return getItemName(option.default)
  }
  return getItemName(option.data)
}

import { Item } from '../../state/items'

export interface SearchableItem<T extends Item = Item> {
  create?: false,
  data: T,
  dividerBefore?: boolean,
  name: string,
  id: string,
  type: T['type'],
}
export interface SearchableAddItem<T extends Item = Item> {
  create: true,
  data?: undefined,
  default: Partial<T> & Pick<T, 'type'>,
  dividerBefore?: boolean,
  id: string,
  type: T['type'],
}
export type AnySearchable = (
  SearchableItem
  | SearchableAddItem
)
export type AnySearchableData = Exclude<AnySearchable['data'], undefined>
export type AnySearchableType = AnySearchable['type']

export const ALL_SEARCHABLE_TYPES: Readonly<Record<AnySearchableType, boolean>> = {
  group: true,
  person: true,
}
export const SEARCHABLE_BASE_SORT_ORDER: AnySearchableType[] = (
  ['person', 'group']
)

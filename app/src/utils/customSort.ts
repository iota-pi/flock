import { compareIds, getItemName, Item, ITEM_TYPES } from '../state/items';

export type CriterionName = (
  'archived' |
  'created' |
  'description' |
  'lastName' |
  'name' |
  'type'
);
export interface SortCriterion {
  type: CriterionName,
  reverse: boolean,
}
export interface CriterionDisplay {
  name: string,
  normal: string,
  reverse: string,
  hide?: boolean,
}
export const CRITERIA_DISPLAY_MAP: Record<CriterionName, CriterionDisplay> = {
  archived: { name: 'Archived', normal: 'Archived last', reverse: 'Archived first', hide: true },
  created: { name: 'Date created', normal: 'Recent first', reverse: 'Recent last' },
  description: { name: 'Description', normal: 'Ascending', reverse: 'Descending' },
  lastName: { name: 'Last Name', normal: 'Ascending', reverse: 'Descending' },
  name: { name: 'Name', normal: 'Ascending', reverse: 'Descending' },
  type: { name: 'Item type', normal: 'Ascending', reverse: 'Descending', hide: true },
};
export const CRITERIA_DISPLAY = Object.entries(CRITERIA_DISPLAY_MAP).filter(
  ([, { hide }]) => !hide,
).sort(
  ([a], [b]) => a.localeCompare(b),
) as [CriterionName, CriterionDisplay][];

export const DEFAULT_CRITERIA: SortCriterion[] = [
  { type: 'name', reverse: false },
];
export const AUTOMATIC_CRITERIA: SortCriterion[] = [
  { type: 'archived', reverse: false },
  { type: 'type', reverse: false },
];

const CRITERION_FUNCTIONS: Record<CriterionName, (a: Item, b: Item) => number> = {
  archived: (a, b) => +a.archived - +b.archived,
  created: (a, b) => b.created - a.created,
  description: (a, b) => a.description.localeCompare(b.description),
  lastName: (a, b) => {
    if (a.type === 'person' && a.type === b.type) {
      return a.lastName.localeCompare(b.lastName);
    }
    return 0;
  },
  name: (a, b) => getItemName(a).localeCompare(getItemName(b)),
  type: (a, b) => ITEM_TYPES.indexOf(a.type) - ITEM_TYPES.indexOf(b.type),
};

const compareItems = (criteria: SortCriterion[]) => (a: Item, b: Item) => {
  const allCriteria = [...AUTOMATIC_CRITERIA, ...criteria];
  for (const criterion of allCriteria) {
    const func = CRITERION_FUNCTIONS[criterion.type];
    const result = func(a, b);
    if (result) {
      return criterion.reverse ? -result : result;
    }
  }
  return compareIds(a, b);
};

export function sortItems<T extends Item>(
  items: T[],
  criteria: SortCriterion[],
) {
  return items.slice().sort(compareItems(criteria));
}

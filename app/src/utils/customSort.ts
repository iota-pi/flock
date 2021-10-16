import { compareIds, getItemName, Item } from '../state/items';

export type CriterionName = (
  'archived' |
  'created' |
  'description' |
  'lastName' |
  'name'
);
export interface SortCriterion {
  type: CriterionName,
  reverse: boolean,
}
export interface CriterionDisplay {
  name: string,
  normal: string,
  reverse: string,
}
export const CRITERIA_DISPLAY_MAP: Record<CriterionName, CriterionDisplay> = {
  archived: { name: 'Archived', normal: 'Archived last', reverse: 'Archived first' },
  created: { name: 'Date created', normal: 'Recent first', reverse: 'Recent last' },
  description: { name: 'Description', normal: 'Ascending', reverse: 'Descending' },
  lastName: { name: 'Last Name', normal: 'Ascending', reverse: 'Descending' },
  name: { name: 'Name', normal: 'Ascending', reverse: 'Descending' },
};
export const CRITERIA_DISPLAY = Object.entries(CRITERIA_DISPLAY_MAP).sort(
  ([a], [b]) => a.localeCompare(b),
) as [CriterionName, CriterionDisplay][];

export const DEFAULT_CRITERIA: SortCriterion[] = [
  { type: 'archived', reverse: false },
  { type: 'name', reverse: false },
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
};

const compareItems = (criteria: SortCriterion[]) => (a: Item, b: Item) => {
  for (const criterion of criteria) {
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

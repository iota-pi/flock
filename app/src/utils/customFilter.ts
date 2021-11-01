import { isSameDay } from '.';
import { getItemName, Item } from '../state/items';
import { getLastInteractionDate } from './interactions';
import { getLastPrayedFor } from './prayer';

export type FilterBaseOperatorName = (
  'is' |
  'contains' |
  'greater'
);
export type FilterOperatorName = (
  FilterBaseOperatorName |
  'isnot' |
  'notcontains' |
  'lessthan' |
  'before' |
  'after'
);
export interface FilterOperator {
  baseOperator: FilterBaseOperatorName,
  inverse: boolean,
  name: string,
}
export const FILTER_OPERATORS_DISPLAY_MAP: Record<FilterOperatorName, FilterOperator> = {
  is: { name: 'Is', baseOperator: 'is', inverse: false },
  isnot: { name: 'Is not', baseOperator: 'is', inverse: true },
  contains: { name: 'Contains', baseOperator: 'contains', inverse: false },
  notcontains: { name: 'Does not contain', baseOperator: 'contains', inverse: true },
  greater: { name: 'Greater', baseOperator: 'greater', inverse: false },
  lessthan: { name: 'Less Than', baseOperator: 'greater', inverse: true },
  before: { name: 'Before', baseOperator: 'greater', inverse: false },
  after: { name: 'After', baseOperator: 'greater', inverse: true },
};

export type FilterCriterionName = (
  'archived' |
  'created' |
  'description' |
  'lastInteraction' |
  'lastPrayedFor' |
  'maturity' |
  'name'
);
export interface FilterCriterionDisplayData {
  name: string,
  operators: FilterOperatorName[],
}
export interface FilterCriterion {
  type: FilterCriterionName,
  operator: FilterBaseOperatorName,
  inverse: boolean,
  value: string | number | boolean,
}
export const FILTER_CRITERIA_DISPLAY_MAP: (
  Record<FilterCriterionName, FilterCriterionDisplayData>
) = {
  archived: {
    name: 'Archived',
    operators: ['is', 'isnot'],
  },
  created: {
    name: 'Date created',
    operators: ['is', 'isnot'],
  },
  description: {
    name: 'Description',
    operators: ['is', 'isnot', 'contains', 'notcontains'],
  },
  lastInteraction: {
    name: 'Last interaction',
    operators: ['is', 'isnot', 'after', 'before'],
  },
  lastPrayedFor: {
    name: 'Last prayed for',
    operators: ['is', 'isnot', 'after', 'before'],
  },
  maturity: {
    name: 'Maturity',
    operators: ['is', 'isnot', 'greater', 'lessthan'],
  },
  name: {
    name: 'Name',
    operators: ['is', 'isnot', 'contains', 'notcontains'],
  },
};
export const FILTER_CRITERIA_DISPLAY = Object.entries(FILTER_CRITERIA_DISPLAY_MAP).sort(
  ([a], [b]) => a.localeCompare(b),
) as [FilterCriterionName, FilterCriterionDisplayData][];

export const DEFAULT_CRITERIA: FilterCriterion[] = [];

export function filterItems<T extends Item>(
  items: T[],
  criteria: FilterCriterion[],
  maturityStages: string[],
) {
  const funcs: Record<FilterCriterionName, (item: Item, criterion: FilterCriterion) => boolean> = {
    archived: (item, criterion) => {
      if (criterion.operator === 'is') {
        return item.archived === criterion.value;
      }
      return true;
    },
    created: (item, criterion) => {
      if (criterion.operator === 'is') {
        return isSameDay(new Date(item.created), new Date(criterion.value as number));
      }
      if (criterion.operator === 'greater') {
        return item.created > (criterion.value as number);
      }
      return true;
    },
    description: (item, criterion) => {
      const description = item.description.toLocaleLowerCase();
      const value = (criterion.value as string).toLocaleLowerCase();
      if (criterion.operator === 'is') {
        return description === value;
      }
      if (criterion.operator === 'contains') {
        return description.includes(value);
      }
      return true;
    },
    lastInteraction: (item, criterion) => {
      if (item.type === 'person') {
        const lastInteraction = getLastInteractionDate(item);
        const value = criterion.value as number;
        if (criterion.operator === 'is') {
          return isSameDay(new Date(lastInteraction), new Date(value));
        }
        if (criterion.operator === 'greater') {
          return item.created > value;
        }
      }
      return true;
    },
    lastPrayedFor: (item, criterion) => {
      const lastPrayer = getLastPrayedFor(item);
      const value = criterion.value as number;
      if (criterion.operator === 'is') {
        return isSameDay(new Date(lastPrayer), new Date(value));
      }
      if (criterion.operator === 'greater') {
        return item.created > value;
      }
      return true;
    },
    maturity: (item, criterion) => {
      if (item.type === 'person') {
        if (criterion.operator === 'is') {
          return item.maturity === criterion.value as string;
        }
        if (criterion.operator === 'greater') {
          return (
            maturityStages.indexOf(item.maturity || '')
            > maturityStages.indexOf(criterion.value as string || '')
          );
        }
      }
      return true;
    },
    name: (item, criterion) => {
      const name = getItemName(item).toLocaleLowerCase();
      const value = (criterion.value as string).toLocaleLowerCase();
      if (criterion.operator === 'is') {
        return name === value;
      }
      if (criterion.operator === 'contains') {
        return name.includes(value);
      }
      return true;
    },
  };

  if (!criteria.length) {
    return items;
  }

  const filteredItems = items.filter(item => {
    for (const criterion of criteria) {
      const func = funcs[criterion.type];
      const baseResult = func(item, criterion);
      const result = criterion.inverse ? !baseResult : baseResult;
      if (!result) {
        return false;
      }
    }
  });
  return filteredItems.length < items.length ? filteredItems : items;
}

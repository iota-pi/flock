import { isSameDay } from '.';
import { getItemName, Item } from '../state/items';
import { getLastInteractionDate } from './interactions';
import { getLastPrayedFor } from './prayer';

export type FilterFieldType = 'string' | 'number' | 'boolean' | 'date' | 'maturity';
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
export const FILTER_OPERATORS_MAP: Record<FilterOperatorName, FilterOperator> = {
  is: { name: 'Is', baseOperator: 'is', inverse: false },
  isnot: { name: 'Is not', baseOperator: 'is', inverse: true },
  contains: { name: 'Contains', baseOperator: 'contains', inverse: false },
  notcontains: { name: 'Does not contain', baseOperator: 'contains', inverse: true },
  lessthan: { name: 'Less Than', baseOperator: 'greater', inverse: true },
  greater: { name: 'Greater', baseOperator: 'greater', inverse: false },
  before: { name: 'Before', baseOperator: 'greater', inverse: true },
  after: { name: 'After', baseOperator: 'greater', inverse: false },
};

export type FilterCriterionType = (
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
  archived: {
    dataType: 'boolean',
    name: 'Archived',
    operators: ['is', 'isnot'],
  },
  created: {
    dataType: 'date',
    name: 'Date created',
    operators: ['is', 'isnot', 'after', 'before'],
  },
  description: {
    dataType: 'string',
    name: 'Description',
    operators: ['is', 'isnot', 'contains', 'notcontains'],
  },
  lastInteraction: {
    dataType: 'date',
    name: 'Last interaction',
    operators: ['is', 'isnot', 'after', 'before'],
  },
  lastPrayedFor: {
    dataType: 'date',
    name: 'Last prayed for',
    operators: ['is', 'isnot', 'after', 'before'],
  },
  maturity: {
    dataType: 'maturity',
    name: 'Maturity',
    operators: ['is', 'isnot', 'greater', 'lessthan'],
  },
  name: {
    dataType: 'string',
    name: 'Name',
    operators: ['is', 'isnot', 'contains', 'notcontains'],
  },
};
export const FILTER_CRITERIA_DISPLAY = Object.entries(FILTER_CRITERIA_DISPLAY_MAP).sort(
  ([a], [b]) => a.localeCompare(b),
) as [FilterCriterionType, FilterCriterionDisplayData][];

export const DEFAULT_FILTER_CRITERIA: FilterCriterion[] = [];

export function filterItems<T extends Item>(
  items: T[],
  criteria: FilterCriterion[],
  maturityStages: string[],
) {
  const funcs: Record<FilterCriterionType, (item: Item, criterion: FilterCriterion) => boolean> = {
    archived: (item, criterion) => {
      if (criterion.baseOperator === 'is') {
        return item.archived === criterion.value;
      }
      return true;
    },
    created: (item, criterion) => {
      if (criterion.baseOperator === 'is') {
        return isSameDay(new Date(item.created), new Date(criterion.value as number));
      }
      if (criterion.baseOperator === 'greater') {
        return item.created > (criterion.value as number);
      }
      return true;
    },
    description: (item, criterion) => {
      const description = item.description.toLocaleLowerCase();
      const value = (criterion.value as string).toLocaleLowerCase();
      if (criterion.baseOperator === 'is') {
        return description === value;
      }
      if (criterion.baseOperator === 'contains') {
        return description.includes(value);
      }
      return true;
    },
    lastInteraction: (item, criterion) => {
      if (item.type === 'person') {
        const lastInteraction = getLastInteractionDate(item);
        const value = criterion.value as number;
        if (criterion.baseOperator === 'is') {
          return isSameDay(new Date(lastInteraction), new Date(value));
        }
        if (criterion.baseOperator === 'greater') {
          return item.created > value;
        }
      }
      return true;
    },
    lastPrayedFor: (item, criterion) => {
      const lastPrayer = getLastPrayedFor(item);
      const value = criterion.value as number;
      if (criterion.baseOperator === 'is') {
        return isSameDay(new Date(lastPrayer), new Date(value));
      }
      if (criterion.baseOperator === 'greater') {
        return item.created > value;
      }
      return true;
    },
    maturity: (item, criterion) => {
      if (item.type === 'person') {
        if (criterion.baseOperator === 'is') {
          return item.maturity === criterion.value as string;
        }
        if (criterion.baseOperator === 'greater') {
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
      if (criterion.baseOperator === 'is') {
        return name === value;
      }
      if (criterion.baseOperator === 'contains') {
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
    return true;
  });
  return filteredItems.length < items.length ? filteredItems : items;
}

export function getBaseValue(field: FilterCriterionType): FilterCriterion['value'] {
  const dataType = FILTER_CRITERIA_DISPLAY_MAP[field].dataType;
  if (dataType === 'boolean') return false;
  if (dataType === 'date') return new Date().getTime();
  if (dataType === 'number') return 0;
  if (dataType === 'string') return '';
  if (dataType === 'maturity') return -1;

  throw new Error(`Unknown data type ${dataType}`);
}

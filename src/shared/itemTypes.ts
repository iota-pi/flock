export const ITEM_TYPES = ['person', 'group', 'topic'] as const

export type ItemType = typeof ITEM_TYPES[number]
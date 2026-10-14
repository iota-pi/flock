import {
  ERROR_ITEM_TYPE,
  ITEM_TYPES,
  errorItemSchema,
  standardItemSchema,
  type ErrorItem,
} from '../../shared/schemas/items'
import type { Item } from '../../state/items'
import type { DocCodec, SyncDomain, SyncDomainHooks } from '../../sync/worker/domain'
import { flockMetadataSync } from './metadataSync'

function isItemType(type: unknown): type is (typeof ITEM_TYPES)[number] {
  return ITEM_TYPES.includes(type as (typeof ITEM_TYPES)[number])
}

/** Validates documents against Flock's item schemas, turning anything invalid into an error item */
export const flockItemCodec: DocCodec = {
  decode(id, raw) {
    const normalizedItem = { ...raw, isNew: undefined } as Partial<Item>

    if (normalizedItem.type !== 'group') {
      delete (normalizedItem as Record<string, unknown>).members
      delete (normalizedItem as Record<string, unknown>).memberPrayerFrequency
      delete (normalizedItem as Record<string, unknown>).memberPrayerTarget
    }

    const parsed = standardItemSchema.safeParse(normalizedItem)
    if (parsed.success) {
      return parsed.data as Item
    }

    const errorParsed = errorItemSchema.safeParse(normalizedItem)
    if (errorParsed.success) {
      return errorParsed.data as Item
    }

    return {
      id,
      type: ERROR_ITEM_TYPE,
      name: 'Corrupt Item',
      description: 'This item could not be parsed.',
      created: typeof normalizedItem.created === 'number' ? normalizedItem.created : Date.now(),
      archived: !!normalizedItem.archived,
      prayerFrequency: 'none',
      notes: [],
      prayedFor: [],
      originalType: normalizedItem.type as ErrorItem['originalType'],
      rawSnapshot: raw,
    } as Item
  },

  isCorrupt(doc) {
    return (doc as Item).type === ERROR_ITEM_TYPE
  },

  snapshotKind(doc) {
    const item = doc as Item
    const type = item.type === ERROR_ITEM_TYPE ? item.originalType : item.type
    return isItemType(type) ? type : 'person'
  },
}

export const flockSyncHooks: SyncDomainHooks = {
  remapReferences(doc, oldId, newId) {
    const item = doc as Item
    if (item.type !== 'group' || !Array.isArray(item.members) || !item.members.includes(oldId)) {
      return null
    }
    return { members: item.members.map(member => (member === oldId ? newId : member)) }
  },

  prepareRecreatedDoc(doc) {
    return { ...doc, created: Date.now() }
  },
}

export const flockSyncDomain: SyncDomain = {
  codec: flockItemCodec,
  hooks: flockSyncHooks,
  metadataSync: flockMetadataSync,
}

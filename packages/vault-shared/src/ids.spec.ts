import { generateItemId, ItemIdSchema, settingsDocId } from './ids'
import { MAX_ITEM_ID_LENGTH } from './limits'

describe('ItemIdSchema', () => {
  it.each([
    ['a nanoid', generateItemId()],
    ['a UUID from before nanoids', '0f8fad5b-d9cb-469f-a165-70867728950e'],
    ['a UUID account\'s settings document', settingsDocId('0f8fad5b-d9cb-469f-a165-70867728950e')],
    ['the longest allowed ID', 'a'.repeat(MAX_ITEM_ID_LENGTH)],
  ])('accepts %s', (_case, id) => {
    expect(ItemIdSchema.safeParse(id).success).toBe(true)
  })

  it.each([
    ['an empty ID', ''],
    ['an oversized ID', 'a'.repeat(MAX_ITEM_ID_LENGTH + 1)],
    ['a slash', 'item/1'],
    ['a space inside', 'item 1'],
    ['a non-ASCII letter', 'itém'],
  ])('rejects %s', (_case, id) => {
    expect(ItemIdSchema.safeParse(id).success).toBe(false)
  })
})

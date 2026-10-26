import { generateItemId } from '@vault/shared'
import { validateItem } from './items'

describe('validateItem', () => {
  it('reports an invalid item by its ID, account and length, without its ciphertext', () => {
    const item = generateItemId()
    let message = ''
    try {
      validateItem({ account: 'acct-1', item, cipher: 'secret-ciphertext', metadata: { iv: '', modified: 1 } })
    } catch (error) {
      message = (error as Error).message
    }

    expect(message).toContain('Invalid item format')
    expect(message).toContain(item)
    expect(message).toContain('acct-1')
    expect(message).toMatch(/length \d+/)
    expect(message).not.toContain('secret-ciphertext')
  })
})

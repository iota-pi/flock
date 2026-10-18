import DynamoDriver from './dynamo'
import { GetCommand } from '@aws-sdk/lib-dynamodb'

describe('DynamoDriver.getSecurityParams', () => {
  let driver: DynamoDriver
  let mockSend: ReturnType<typeof vi.fn>

  beforeEach(() => {
    driver = new DynamoDriver()
    mockSend = vi.fn()
    ;(driver as any).internalClient = {
      send: mockSend,
    }
  })

  it('reads the account consistently, so a login straight after signup finds it', async () => {
    mockSend.mockResolvedValueOnce({
      Item: { account: 'acc-123', salt: 'salt', iterations: 100, saltVersion: 2, dataVersion: 3 },
    })

    const result = await driver.getSecurityParams({ account: 'acc-123' })

    const command = mockSend.mock.calls[0][0]
    expect(command).toBeInstanceOf(GetCommand)
    expect(command.input).toEqual({
      TableName: driver.tables.accounts,
      Key: { account: 'acc-123' },
      ConsistentRead: true,
    })
    expect(result).toEqual({ salt: 'salt', iterations: 100, saltVersion: 2, dataVersion: 3 })
  })
})

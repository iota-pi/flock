import DynamoDriver, { ITEM_TABLE_NAME } from './dynamo'
import { QueryCommand } from '@aws-sdk/lib-dynamodb'

describe('DynamoDriver.fetchManifest', () => {
  let driver: DynamoDriver
  let mockSend: ReturnType<typeof vi.fn>

  beforeEach(() => {
    driver = new DynamoDriver()
    mockSend = vi.fn()
    // Inject mock internalClient
    ;(driver as any).internalClient = {
      send: mockSend,
    }
  })

  it('queries items table with projection for deleted flags and returns deleted property for tombstones', async () => {
    mockSend.mockResolvedValueOnce({
      Items: [
        {
          item: 'item-active-1',
          modifiedAt: 1000,
          metadata: { modified: 1000 },
        },
        {
          item: 'item-deleted-metadata',
          modifiedAt: 2000,
          metadata: { modified: 2000, deleted: true },
        },
        {
          item: 'item-deleted-toplevel',
          modifiedAt: 3000,
          metadata: { modified: 3000 },
          deleted: true,
        },
        {
          item: 'item-active-2',
          modifiedAt: 4000,
          metadata: { modified: 4000, deleted: false },
        },
      ],
      LastEvaluatedKey: undefined,
    })

    const result = await driver.fetchManifest({ account: 'acc-123' })

    expect(mockSend).toHaveBeenCalledTimes(1)
    const command = mockSend.mock.calls[0][0]
    expect(command).toBeInstanceOf(QueryCommand)
    expect(command.input).toMatchObject({
      TableName: ITEM_TABLE_NAME,
      KeyConditionExpression: 'account = :accountid',
      ExpressionAttributeNames: {
        '#itemKey': 'item',
        '#modifiedAt': 'modifiedAt',
        '#metadata': 'metadata',
        '#deleted': 'deleted',
      },
      ExpressionAttributeValues: {
        ':accountid': 'acc-123',
      },
      ProjectionExpression: '#itemKey, #modifiedAt, #metadata.modified, #metadata.#deleted, #deleted',
    })

    expect(result).toEqual([
      { itemId: 'item-active-1', modifiedAt: 1000 },
      { itemId: 'item-deleted-metadata', modifiedAt: 2000, deleted: true },
      { itemId: 'item-deleted-toplevel', modifiedAt: 3000, deleted: true },
      { itemId: 'item-active-2', modifiedAt: 4000 },
    ])
  })

  it('handles multi-page pagination with LastEvaluatedKey correctly', async () => {
    mockSend
      .mockResolvedValueOnce({
        Items: [
          { item: 'item-p1', modifiedAt: 100 },
        ],
        LastEvaluatedKey: { account: 'acc-123', item: 'item-p1' },
      })
      .mockResolvedValueOnce({
        Items: [
          { item: 'item-p2', modifiedAt: 200, metadata: { deleted: true } },
        ],
        LastEvaluatedKey: undefined,
      })

    const result = await driver.fetchManifest({ account: 'acc-123' })

    expect(mockSend).toHaveBeenCalledTimes(2)
    expect(mockSend.mock.calls[1][0].input.ExclusiveStartKey).toEqual({
      account: 'acc-123',
      item: 'item-p1',
    })

    expect(result).toEqual([
      { itemId: 'item-p1', modifiedAt: 100 },
      { itemId: 'item-p2', modifiedAt: 200, deleted: true },
    ])
  })
})

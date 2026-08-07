import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  DynamoDBDocumentClient,
  QueryCommand,
  QueryCommandInput,
  BatchWriteCommand
} from '@aws-sdk/lib-dynamodb'
import { chunk } from 'lodash-es'
import { getConnectionParams } from 'src/vault/drivers/dynamo'

const SOURCE_TABLE = process.env.SOURCE_TABLE || 'FlockItems_production'
const DEST_TABLE = process.env.DEST_TABLE || 'FlockItems_staging'
const SOURCE_ACCOUNT = process.env.SOURCE_ACCOUNT
const DEST_ACCOUNT = process.env.DEST_ACCOUNT || SOURCE_ACCOUNT

if (!SOURCE_ACCOUNT) {
  console.error('SOURCE_ACCOUNT environment variable is required.')
  process.exit(1)
}

const client = new DynamoDBClient(getConnectionParams())

const docClient = DynamoDBDocumentClient.from(client, {
  marshallOptions: {
    removeUndefinedValues: true,
  },
})

async function copyAccountItems() {
  let lastEvaluatedKey: Record<string, any> | undefined = undefined
  let totalCopied = 0

  console.log(`Starting copy for account ${SOURCE_ACCOUNT} -> ${DEST_ACCOUNT}...`)

  do {
    // Query is much faster than Scan because it targets the Partition Key directly
    const queryParams: QueryCommandInput = {
      TableName: SOURCE_TABLE,
      KeyConditionExpression: '#account = :sourceAccount',
      ExpressionAttributeNames: {
        '#account': 'account',
      },
      ExpressionAttributeValues: {
        ':sourceAccount': SOURCE_ACCOUNT,
      },
      ExclusiveStartKey: lastEvaluatedKey,
    }

    // Note: You can still add a `FilterExpression` here if you only want
    // to copy a specific subset of this account's items.

    const queryResponse = await docClient.send(new QueryCommand(queryParams))
    const items = queryResponse.Items || []

    if (items.length > 0) {
      // Re-map the account property so it correctly anchors to the destination account
      const migratedItems = items.map(item => ({
        ...item,
        account: DEST_ACCOUNT,
        isNew: undefined,
      }))

      const itemChunks = chunk(migratedItems, 25)

      for (const itemChunk of itemChunks) {
        const putRequests = itemChunk.map((item) => ({
          PutRequest: { Item: item },
        }))

        await docClient.send(
          new BatchWriteCommand({
            RequestItems: {
              [DEST_TABLE]: putRequests,
            },
          })
        )
        totalCopied += itemChunk.length
      }
    }

    lastEvaluatedKey = queryResponse.LastEvaluatedKey
    console.log(`Processed a batch. Running total: ${totalCopied}`)

  } while (lastEvaluatedKey)

  console.log(`Copy operation complete! Successfully migrated ${totalCopied} items.`)
}

copyAccountItems().catch((error) => {
  console.error('Error during the copy operation:', error)
  process.exit(1)
})

import {
  DynamoDBDocumentClient,
  PutCommand,
  PutCommandOutput,
  QueryCommand,
  QueryCommandInput,
  QueryCommandOutput,
  UpdateCommand,
  UpdateCommandOutput,
} from '@aws-sdk/lib-dynamodb'
import { isConditionalCheckFailure } from './dynamoErrors'
import type { VaultTableNames } from './config'

/**
 * What the driver's operations need. The driver builds it per call, so a spy on the client's `send`
 * (or a client set by `connect` after construction) is always the one used.
 */
export interface DynamoContext {
  client: DynamoDBDocumentClient
  tables: VaultTableNames
}

/** Sends a conditional write. Resolves to undefined, instead of throwing, when the condition fails. */
export async function sendConditional(client: DynamoDBDocumentClient, command: PutCommand): Promise<PutCommandOutput | undefined>
export async function sendConditional(client: DynamoDBDocumentClient, command: UpdateCommand): Promise<UpdateCommandOutput | undefined>
export async function sendConditional(client: DynamoDBDocumentClient, command: PutCommand | UpdateCommand) {
  try {
    // `send` takes one command type at a time; the overloads above give each caller its output type
    return await client.send(command as UpdateCommand)
  } catch (error) {
    if (!isConditionalCheckFailure(error)) {
      throw error
    }
    return undefined
  }
}

/** Runs a query to the end, yielding the records of each page as it arrives */
export async function* queryAll(
  client: DynamoDBDocumentClient,
  input: Omit<QueryCommandInput, 'ExclusiveStartKey'>,
): AsyncGenerator<NonNullable<QueryCommandOutput['Items']>[number]> {
  let exclusiveStartKey: QueryCommandOutput['LastEvaluatedKey']
  do {
    const response = await client.send(new QueryCommand({ ...input, ExclusiveStartKey: exclusiveStartKey }))
    yield* response.Items ?? []
    exclusiveStartKey = response.LastEvaluatedKey
  } while (exclusiveStartKey)
}

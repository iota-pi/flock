// Ensure `DYNAMODB_ENDPOINT` is set when running tests locally from the host
// Default to the common DynamoDB Local address used by `docker compose`
if (!process.env.DYNAMODB_ENDPOINT) {
  process.env.DYNAMODB_ENDPOINT = 'http://localhost:8000'
}

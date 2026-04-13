import getDriver from '.'

process.env.DYNAMODB_ENDPOINT ??= 'http://localhost:8000'
getDriver('dynamo').init()

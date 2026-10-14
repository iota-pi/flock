import { createFlockDriver } from './flockDriver'

process.env.DYNAMODB_ENDPOINT ??= 'http://localhost:8000'
createFlockDriver().init()

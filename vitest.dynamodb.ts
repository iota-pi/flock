import type { TestProject } from 'vitest/node'
import { createFlockDriver } from './src/vault/flockDriver'

/**
 * Creates the tables that tests share in the test DynamoDB Local. It keeps them only in memory, so
 * they're gone whenever its container restarts. Each project that uses DynamoDB runs this, and
 * creating a table that exists already is skipped.
 */
export default async function setup(project: TestProject) {
  process.env.DYNAMODB_ENDPOINT = project.config.env.DYNAMODB_ENDPOINT
  const driver = createFlockDriver()
  const { info } = console
  console.info = () => {}
  try {
    await driver.init()
  } catch (error) {
    // Let tests that don't need DynamoDB run without Docker. Those that do fail on their own.
    console.warn(`Could not create the test tables at ${process.env.DYNAMODB_ENDPOINT}. Is \`docker compose up -d\` running?`, error)
  } finally {
    console.info = info
    driver.client.destroy()
  }
}

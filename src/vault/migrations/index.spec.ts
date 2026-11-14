import { handler } from '.'

describe('migration handler', () => {
  it.each(['noSuchMigration', 'constructor', 'toString', '__proto__', 'hasOwnProperty'])(
    'rejects %s, which is not a migration',
    async migrationName => {
      await expect(handler({ migrationName })).rejects.toThrow(`Unknown migration ${migrationName}`)
    },
  )

  it.each(['backupAuthToken', 'hashAuthToken', 'installHashAuthToken', 'cleanUpAuthToken', 'addModifiedTime'])(
    'no longer offers the retired migration %s',
    async migrationName => {
      await expect(handler({ migrationName })).rejects.toThrow(`Unknown migration ${migrationName}`)
    },
  )
})

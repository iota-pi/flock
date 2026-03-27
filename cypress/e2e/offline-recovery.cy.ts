function seedDeadLetterMutation(id: string, label: string) {
  cy.window().then(win => {
    return new Cypress.Promise<void>((resolve, reject) => {
      const writePayload = (db: IDBDatabase) => {
        const transaction = db.transaction('keyvaluepairs', 'readwrite')
        const store = transaction.objectStore('keyvaluepairs')

        const payload = [{
          id,
          mutationType: 'items.put',
          payload: { test: label },
          endpoint: 'http://localhost:4000',
          lastErrorStatus: 500,
        }]

        const writeRequest = store.put(payload, 'dead-letter-mutations')
        writeRequest.onerror = () => {
          db.close()
          reject(writeRequest.error)
        }
        writeRequest.onsuccess = () => {
          db.close()
          resolve()
        }
      }

      const request = win.indexedDB.open('FlockVaultDB')
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const db = request.result

        if (db.objectStoreNames.contains('keyvaluepairs')) {
          writePayload(db)
          return
        }

        const nextVersion = db.version + 1
        db.close()

        const upgradeRequest = win.indexedDB.open('FlockVaultDB', nextVersion)
        upgradeRequest.onerror = () => reject(upgradeRequest.error)
        upgradeRequest.onupgradeneeded = () => {
          const upgradedDb = upgradeRequest.result
          if (!upgradedDb.objectStoreNames.contains('keyvaluepairs')) {
            upgradedDb.createObjectStore('keyvaluepairs')
          }
        }
        upgradeRequest.onsuccess = () => {
          writePayload(upgradeRequest.result)
        }
      }
    })
  })
}

describe('Offline recovery', () => {
  it('shows seeded failed mutations and supports discard recovery flow', () => {
    const uniqueId = Date.now().toString().slice(-6)
    seedDeadLetterMutation(`dlq-${uniqueId}`, `failed-${uniqueId}`)

    cy.page('settings')
    cy.contains('Offline data recovery').should('be.visible').click()
    cy.contains('Offline Data Recovery').should('be.visible')
    cy.contains('button', 'Retry').should('have.length', 1)

    cy.contains('button', 'Discard').click()
    cy.contains('No offline recovery actions are required right now.').should('be.visible')
  })
})

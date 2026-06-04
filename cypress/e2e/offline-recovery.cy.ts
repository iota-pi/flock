function seedManualRecoveryEntry(id: string, label: string) {
  cy.window().then(win => {
    return new Cypress.Promise<void>((resolve, reject) => {
      const storeName = 'manual-recovery-items'

      const writePayload = (db: IDBDatabase) => {
        const transaction = db.transaction(storeName, 'readwrite')
        const store = transaction.objectStore(storeName)

        const payload = {
          id,
          itemId: `item-${id}`,
          reason: `failed-${label}`,
          createdAt: Date.now(),
        }

        const writeRequest = store.put(payload, payload.id)
        writeRequest.onerror = () => {
          db.close()
          reject(writeRequest.error)
        }
        writeRequest.onsuccess = () => {
          db.close()
          resolve()
        }
      }

      const request = win.indexedDB.open('FlockVault_ManualRecoveryDB')
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const db = request.result

        if (db.objectStoreNames.contains(storeName)) {
          writePayload(db)
          return
        }

        const nextVersion = db.version + 1
        db.close()

        const upgradeRequest = win.indexedDB.open('FlockVault_ManualRecoveryDB', nextVersion)
        upgradeRequest.onerror = () => reject(upgradeRequest.error)
        upgradeRequest.onupgradeneeded = () => {
          const upgradedDb = upgradeRequest.result
          if (!upgradedDb.objectStoreNames.contains(storeName)) {
            upgradedDb.createObjectStore(storeName)
          }
        }
        upgradeRequest.onsuccess = () => {
          writePayload(upgradeRequest.result)
        }
      }
    })
  })
}

describe('Data recovery', () => {
  it('shows seeded failed mutations and supports discard recovery flow', () => {
    const uniqueId = Date.now().toString().slice(-6)
    seedManualRecoveryEntry(`recovery-${uniqueId}`, `failed-${uniqueId}`)

    cy.page('settings')
    cy.contains('Corrupted data recovery').should('be.visible').click()
    cy.contains('Corrupted Data Recovery').should('be.visible')
    cy.checkA11y('[role="dialog"]')
    cy.contains('button', 'Retry').should('have.length', 1)

    cy.contains('button', 'Dismiss').click()
    cy.contains('No corrupted data recovery actions are required right now.').should('be.visible')
  })
})

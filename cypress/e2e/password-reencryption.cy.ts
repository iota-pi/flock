describe('Password Change and Vault Re-encryption', () => {
  const CURRENT_PASSWORD = 'TestPass123!'
  const NEW_PASSWORD = 'NewTestPass123!'

  beforeEach(() => {
    // Clean up local state
    cy.clearLocalStorage()
    cy.window().then((win) => {
      const dbNames = [
        'FlockVaultDB',
        'FlockVault_SyncBatchDB',
        'FlockVault_DeletionQueueDB',
        'FlockVault_ManualRecoveryDB',
      ]
      return Cypress.Promise.all(
        dbNames.map(
          (name) =>
            new Cypress.Promise<void>((resolve, reject) => {
              const req = win.indexedDB.deleteDatabase(name)
              req.onsuccess = () => resolve()
              req.onerror = () => reject(req.error)
              req.onblocked = () => resolve()
            })
        )
      ) as unknown as Promise<void>
    })

    // Register a new user
    cy.visit('/welcome')
    cy.createAccount(CURRENT_PASSWORD)
    cy.page('people')
    cy.dataCy('page-content-people').should('exist')
  })


  it('prompts user to re-encrypt vault items after password change and completes re-encryption', () => {
    // Create an item programmatically to make sure there is something to re-encrypt
    cy.createPerson({ name: 'Bob Smith' })

    cy.page('settings')

    // Open Change Password dialog
    cy.dataCy('change-password').click()
    cy.get('[data-cy="dialog-current-password-input"]').type(CURRENT_PASSWORD)
    cy.get('[data-cy="dialog-new-password-input"]').type(NEW_PASSWORD)
    cy.get('[data-cy="dialog-confirm-password-input"]').type(NEW_PASSWORD)

    // Submit password change
    cy.get('[data-cy="dialog-confirm"]').click()

    // Verify Reencrypt dialog options appear
    cy.get('[data-cy="reencrypt-dialog-skip"]').should('be.visible')
    cy.get('[data-cy="reencrypt-dialog-start"]').should('be.visible')

    // Intercept snapshot mutation
    cy.intercept('POST', '**/trpc/items.putSnapshots*').as('putSnapshots')

    // Start re-encryption
    cy.get('[data-cy="reencrypt-dialog-start"]').click()

    // Verify progress text and bar appear
    cy.get('[data-cy="reencrypt-progress-text"]').should('be.visible')
    cy.get('[data-cy="reencrypt-progress-bar"]').should('be.visible')

    // Wait for the snapshots to be uploaded
    cy.wait('@putSnapshots').then((interception) => {
      expect(interception.response?.statusCode).to.eq(200)
    })

    // Verify the dialog closes automatically on success
    cy.get('[data-cy="reencrypt-dialog-start"]').should('not.exist')
  })
})

describe('Password Change and Vault Re-encryption', () => {
  const CURRENT_PASSWORD = 'TestPass123!'
  const NEW_PASSWORD = 'NewTestPass123!'

  beforeEach(() => {
    // Clean up local state
    cy.clearLocalStorage()
    cy.window().then((win) => {
      return new Cypress.Promise<void>((resolve, reject) => {
        const req = win.indexedDB.deleteDatabase('FlockVaultDB')
        req.onsuccess = () => resolve()
        req.onerror = () => reject(req.error)
        req.onblocked = () => resolve()
      })
    })

    // Register a new user
    cy.visit('/welcome')
    cy.createAccount(CURRENT_PASSWORD)
    cy.page('people')
    cy.dataCy('page-content-people').should('exist')
  })

  it('prompts user to re-encrypt vault items after a password change, and allows skipping', () => {
    cy.page('settings')

    // Open Change Password dialog
    cy.dataCy('change-password').click()
    cy.get('[data-cy="dialog-current-password-input"]').type(CURRENT_PASSWORD)
    cy.get('[data-cy="dialog-new-password-input"]').type(NEW_PASSWORD)
    cy.get('[data-cy="dialog-confirm-password-input"]').type(NEW_PASSWORD)

    // Submit password change
    cy.get('[data-cy="dialog-confirm"]').click()

    // Verify Reencrypt dialog appears
    cy.get('[data-cy="reencrypt-dialog-skip"]').should('be.visible')
    cy.get('[data-cy="reencrypt-dialog-start"]').should('be.visible')

    // Dismiss/Skip the prompt
    cy.get('[data-cy="reencrypt-dialog-skip"]').click()

    // Verify dialog is closed
    cy.get('[data-cy="reencrypt-dialog-skip"]').should('not.exist')
  })

  it('re-encrypts vault items on demand and shows progress', () => {
    // Create an item to make sure there is something to re-encrypt
    cy.createPerson({ name: 'Bob Smith' }, true).saveDrawer()

    cy.page('settings')

    // Open Change Password dialog
    cy.dataCy('change-password').click()
    cy.get('[data-cy="dialog-current-password-input"]').type(CURRENT_PASSWORD)
    cy.get('[data-cy="dialog-new-password-input"]').type(NEW_PASSWORD)
    cy.get('[data-cy="dialog-confirm-password-input"]').type(NEW_PASSWORD)

    // Submit password change
    cy.get('[data-cy="dialog-confirm"]').click()

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

describe('Keyring Server Sync and Restoration', () => {
  const TEST_PASSWORD = 'TestPass123!'

  it('syncs keyring to server during registration and restores it on a clean login', () => {
    // 0. Sign out of the session automatically established by the beforeEach hook
    cy.page('settings')
    cy.dataCy('logout').click()
    cy.location('pathname').should('equal', '/welcome')
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

    // 1. Intercept keyring TRPC endpoints
    cy.intercept('POST', '**/trpc/accounts.updateKeyring*').as('updateKeyring')
    cy.intercept('GET', '**/trpc/accounts.getKeyring*').as('getKeyring')

    // 2. Start a fresh registration
    cy.visit('/welcome')
    cy.createAccount(TEST_PASSWORD)

    // Verify registration triggers updateKeyring with ciphertext payload
    cy.wait('@getKeyring')
    cy.wait('@updateKeyring').then((interception) => {
      expect(interception.response?.statusCode).to.eq(200)
      
      const body = interception.request.body
      cy.log('UpdateKeyring request body:', JSON.stringify(body))
      
      // Extract the input payload
      const input = body?.[0]?.json || body?.[0] || body?.json || body || {}
      expect(input).to.have.property('keyring')
      expect(input.keyring).to.be.a('string')
      
      // The keyring is a serialized ciphertext object JSON-wrapped
      const encryptedKeyring = JSON.parse(input.keyring)
      expect(encryptedKeyring).to.have.property('iv')
      expect(encryptedKeyring).to.have.property('cipher')
    })

    // Capture the newly created account ID from localStorage
    let accountId = ''
    cy.window().its('localStorage').then((ls) => {
      const meta = JSON.parse(ls.getItem('FlockVaultMeta') || '{}')
      accountId = meta.account
      expect(accountId).to.not.be.empty
    })

    // 3. Log out and clear local state to simulate a new device / fresh load
    cy.page('settings')
    cy.dataCy('logout').click()
    cy.location('pathname').should('equal', '/welcome')

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

    // 4. Log in as the same user
    cy.visit('/login')
    cy.then(() => {
      cy.get('#username').type(accountId)
      cy.get('#current-password').type(TEST_PASSWORD)
      cy.dataCy('login').click()
    })

    // Verify login fetches the keyring from the server via getKeyring
    cy.wait('@getKeyring').then((interception) => {
      expect(interception.response?.statusCode).to.eq(200)
      const body = interception.response?.body
      cy.log('GetKeyring response body:', JSON.stringify(body))
      
      const resultObj = body?.[0]?.result?.data?.json || body?.[0]?.result?.data || body?.result?.data?.json || body?.result?.data || {}
      expect(resultObj.keyring).to.be.a('string')
    })

    // Verify we successfully land on the main page, implying keyring decryption succeeded
    cy.location('pathname', { timeout: 15000 }).should('equal', '/')
    cy.page('people')
    cy.dataCy('page-content-people').should('exist')
  })
})

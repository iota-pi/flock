describe('Backup & restore', () => {
  beforeEach(() => {
    cy.visit('/')
    cy.createAccount('fnG8iv4t!%Qa')
  })

  it('can backup and restore from backup', () => {
    // Create test data
    cy.createPerson({ name: 'Frodo' })
      .saveDrawer()
    cy.createPerson({ name: 'Merry' })
      .saveDrawer()

    // Create backup
    cy.page('settings')
    cy.dataCy('export').click()

    // Add a new item
    cy.createPerson({ name: 'Pippin' })
      .saveDrawer()

    // Delete an item
    cy.contains('Merry').click()
    cy.dataCy('drawer-cancel').click()
    cy.dataCy('confirm-confirm').click()

    // Edit an item
    cy.contains('Frodo').click()
    cy.dataCy('name').type(' Baggins')
      .saveDrawer()

    // Restore backup
    cy.page('settings')
    cy.dataCy('restore').click()
    cy.get('input[type=file]').attachFile('../downloads/flock.backup.json')
    cy.dataCy('import-confirm').click()

    // Check restore
    cy.page('people')
    cy.contains('Frodo')
    cy.contains('Merry')
    cy.contains('Pippin')
    cy.contains('Baggins').should('not.exist')
  })
})

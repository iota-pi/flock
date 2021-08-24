describe('create account', () => {
  beforeEach(() => {
    cy.visit('http://localhost:3000')
    cy.createAccount('wellthisisverysecureisn\'tit?')
  })

  it('can backup and restore from backup', () => {
    // Create test data
    cy.createPerson({ firstName: 'Frodo' })
      .saveDrawer()
    cy.createPerson({ firstName: 'Merry' })
      .saveDrawer()

    // Create backup
    cy.dataCy('page-settings').click()
    cy.dataCy('export').click()

    // Add a new item
    cy.createPerson({ firstName: 'Pippin' })
      .saveDrawer()

    // Delete an item
    cy.contains('Merry').click()
    cy.dataCy('drawer-cancel').click()
    cy.dataCy('confirm-confirm').click()

    // Edit an item
    cy.contains('Frodo').click()
    cy.dataCy('lastName').type('Baggins')
      .saveDrawer()

    // Restore backup
    cy.dataCy('page-settings').click()
    cy.dataCy('import').click()
    cy.get('input[type=file]').attachFile('../downloads/flock.backup.json')
    cy.dataCy('import-confirm').click()

    // Check restore
    cy.dataCy('page-people').click()
    cy.contains('Frodo')
    cy.contains('Merry')
    cy.contains('Pippin')
    cy.contains('Baggins').should('not.exist')
  })
})

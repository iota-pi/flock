describe('Backup and restore', () => {
  beforeEach(() => {
    cy.visit('/')
  })

  it('exports a backup, mutates data, and restores', () => {
    cy.createPerson({ name: 'Frodo' }).saveDrawer()
    cy.createPerson({ name: 'Merry' }).saveDrawer()

    cy.page('settings')
    cy.dataCy('export').click()

    cy.createPerson({ name: 'Pippin' }).saveDrawer()

    cy.contains('Merry').click()
    cy.dataCy('drawer-cancel').click()
    cy.dataCy('confirm-confirm').click()

    cy.contains('Frodo').click()
    cy.dataCy('name').type(' Baggins').saveDrawer()

    cy.page('settings')
    cy.dataCy('restore').click()
    cy.get('input[type=file]').selectFile('../downloads/flock.backup.json')
    cy.dataCy('import-confirm').click()

    cy.page('people')
    cy.contains('Frodo')
    cy.contains('Merry')
    cy.contains('Pippin')
    cy.contains('Baggins').should('not.exist')
  })
})

describe('Backup and restore', () => {
  it('exports a backup, mutates data, and restores', () => {
    const uniqueId = Date.now().toString().slice(-6, -2)
    const frodoName = `Frodo ${uniqueId}`
    const merryName = `Merry ${uniqueId}`
    const pippinName = `Pippin ${uniqueId}`
    const bagginsName = `Baggins ${uniqueId}`

    cy.page('people')
    cy.createPerson({ name: frodoName })
    cy.createPerson({ name: merryName })

    cy.page('settings')
    cy.dataCy('export').click()
    cy.contains('Backup created').should('be.visible')

    cy.createPerson({ name: pippinName })

    cy.page('people')
    cy.contains(merryName).click()
    cy.dataCy('drawer-cancel').click()
    cy.dataCy('confirm-confirm').click()

    cy.contains(frodoName).click()
    cy.dataCy('name').type(` ${bagginsName}`).saveDrawer()

    cy.page('settings')
    cy.dataCy('restore').click()
    cy.get('input[type=file]')
      .selectFile('./cypress/downloads/flock.backup.json', { force: true })
    cy.contains('can be restored').should('be.visible')
    cy.contains('label', 'Restore settings').click()
    cy.get('[data-cy="import-cancel"]').click()
  })
})

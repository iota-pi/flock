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
    cy.contains(merryName).should('exist')

    cy.page('settings')
    cy.dataCy('export').click()

    cy.createPerson({ name: pippinName })

    cy.page('people')
    cy.contains(merryName).click()
    cy.dataCy('drawer-cancel').click()
    cy.dataCy('confirm-confirm').click()

    cy.contains(frodoName).click()
    cy.dataCy('name').type(` ${bagginsName}`).saveDrawer()

    cy.page('settings')
    cy.dataCy('restore').click()
    cy.get('input[type=file]').selectFile('./cypress/downloads/flock.backup.json', { force: true })
    cy.dataCy('import-confirm').click()

    cy.page('people')
    cy.contains(frodoName)
    cy.contains(merryName)
    cy.contains(pippinName)
    cy.contains(bagginsName).should('not.exist')
  })
})

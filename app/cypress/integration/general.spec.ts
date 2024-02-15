describe('Basic operation', () => {
  beforeEach(() => {
    cy.visit('/')
    cy.createAccount('fnG8iv4t!%Qa')
  })

  it('can create groups; add & remove members', () => {
    cy.createPerson({ name: 'Frodo' })
      .saveDrawer()
    cy.createPerson({ name: 'Pippin' })
      .saveDrawer()
    cy.createPerson({ name: 'Merry' })
      .saveDrawer()
    cy.createGroup({ name: 'Fellowship of the Ring' })
      .addMember('Frodo')
      .addMember('Pippin')
      .addMember('Merry')
    cy.contains(/group report/i)
      .should('be.disabled')
      .saveDrawer()
    cy.createPerson({ name: 'Gandalf' })
      .addToGroup('f')
      .saveDrawer()

    cy.page('groups')
    cy.contains('4 members').click()
    cy.contains(/group report/i)
      .should('not.be.disabled')
    cy.dataCy('section-members').click()
    cy.contains('Gandalf')
      .parentsUntil('[data-cy=list-item]')
      .parent()
      .find('[data-cy=list-item-action]')
      .click()
      .saveDrawer()
    cy.contains('3 members')
  })

  it('can create people items, edit tags and frequencies', () => {
    cy.createPerson({ name: 'Athelas' })
      .dataCy('frequency-selection-prayer').click()
      .dataCy('frequency-weekly').click()
      .addTag('Plant')
      .saveDrawer()
    cy.createPerson({ name: 'Mallorn' })
      .dataCy('frequency-selection-prayer').click()
      .dataCy('frequency-annually').click()
      .addTag('Plant')
      .addTag('Shiny')
      .saveDrawer()
    cy.createPerson({ name: 'The One Ring' })
      .dataCy('frequency-selection-prayer').click()
      .dataCy('frequency-daily').click()
      .addTag('p')
      .addTag('p')  // should add and remove "Plant"
      .addTag('s')
      .addTag('Evil')
      .saveDrawer()

    cy.dataCy('tag')
      .filter((i, e) => /plant/i.test(e.innerText))
      .should('have.length', 2)
    cy.dataCy('tag')
      .filter((i, e) => /shiny/i.test(e.innerText))
      .should('have.length', 2)
    cy.dataCy('tag')
      .filter((i, e) => /evil/i.test(e.innerText))
      .should('have.length', 1)

    cy.page('prayer')
    cy.dataCy('list-item').eq(0).contains('One Ring')
    cy.dataCy('list-item').eq(1).contains('Athelas')
    cy.dataCy('list-item').eq(2).contains('Mallorn')
  })

  it('opening/closing nested drawers works correctly', () => {
    // Requires "desktop" width for testing the permanent-drawer mechanics
    cy.viewport(1280, 720)

    // Create some test items
    cy.createGroup({ name: 'Fellowship of the Ring' })
      .saveDrawer()
    cy.createPerson({ name: 'Bilbo Baggins' })
    cy.createPerson({ name: 'Frodo Baggins' })
      .addToGroup('Fellowship')

    // Open a nested drawer and edit it
    cy.contains('Fellowship').click()
    cy.dataCy('add-description').last().click()
    cy.dataCy('description')
      .last()
      .type('Nine vs. nine, who will win?')
      .saveDrawer()

    // Open a different drawer
    cy.contains('Bilbo').click()

    // Bilbo's drawer should not be stacked so we should now be able to change pages
    cy.page('prayer')

    // Check prayer report for Bilbo
    cy.dataCy('page-content')
      .contains('Bilbo')
      .click()
    cy.dataCy('drawer-content')
      .contains('Bilbo Baggins')
    cy.dataCy('drawer-content')
      .find('[data-cy=firstName]')
      .should('not.exist')

    // Switch to Frodo (should not nest drawer)
    cy.contains('Frodo').click()
    cy.dataCy('drawer-content')
      .first()
      .contains('Bilbo')
      .should('not.exist')
  })
})

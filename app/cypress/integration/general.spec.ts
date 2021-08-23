describe('create account', () => {
  beforeEach(() => {
    cy.visit('http://localhost:3000')
    cy.createAccount('wellthisisverysecureisn\'tit?');
  });

  it('can create and edit items', () => {
    cy.createPerson({ firstName: 'Frodo', lastName: 'Baggins' })
      .saveDrawer()
      .reload()
    cy.dataCy('page-content')
      .contains('Frodo Baggins')
      .click()
    cy.dataCy('description').type('aka. Mr. Underhill')
    cy.saveDrawer()
    cy.dataCy('page-content')
      .contains('Underhill')
  });

  it('can add notes', () => {
    cy.createPerson({ firstName: 'Frodo', lastName: 'Baggins' })
      .addNote({ content: '', type: 'interaction' })
      .addNote({
        content: 'Tried eavesdropping on his conversation',
        type: 'interaction',
        sensitive: true,
      })
      .addNote({ content: 'Safe travels & self control', type: 'prayer' })
      .saveDrawer()
    cy.dataCy('page-prayer').click()
    cy.dataCy('page-content')
      .contains('Frodo Baggins')
      .click()
    cy.dataCy('drawer-content')
      .contains('Frodo Baggins')
    cy.dataCy('drawer-content')
      .contains('eavesdropping')
      .should('not.exist')
    cy.dataCy('drawer-content')
      .contains('Safe travels')
    cy.dataCy('drawer-done').click()
  });

  it('can add action', () => {
    cy.createPerson({ firstName: 'Frodo', lastName: 'Baggins' })
      .addNote({ content: 'Trim hedges', type: 'action' })
      .addNote({ content: 'Cook taters', type: 'action' })
      .addNote({ content: 'Bully Gollum', type: 'action', sensitive: true })
      .saveDrawer()
    cy.dataCy('page-actions').click()
    cy.dataCy('page-content')
      .contains('Frodo Baggins')
    cy.dataCy('page-content')
      .contains('Trim hedges')
    cy.dataCy('page-content')
      .contains('Cook taters')
    cy.dataCy('page-content')
      .contains('Bully gollum')
      .should('not.exist')
  });

  it('can create groups; add & remove members', () => {
    cy.createPerson({ firstName: 'Frodo' })
      .saveDrawer()
    cy.createPerson({ firstName: 'Pippin' })
      .saveDrawer()
    cy.createPerson({ firstName: 'Merry' })
      .saveDrawer()
    cy.createGroup({ name: 'Fellowship of the Ring' })
      .addMember('Frodo')
      .addMember('Pippin')
      .addMember('Merry')
      .saveDrawer()
    cy.createPerson({ firstName: 'Gandalf' })
      .addToGroup('f')
      .saveDrawer()

    cy.dataCy('page-groups').click()
    cy.contains('4 members').click()
    cy.dataCy('section-members').click()
    cy.contains('Gandalf')
      .parentsUntil('[data-cy=list-item]')
      .parent()
      .find('[data-cy=list-item-action]')
      .click()
      .saveDrawer()
    cy.contains('3 members')
  });

  it('can create other items, edit frequencies', () => {
    cy.createOther({ name: 'Athelas' })
      .dataCy('frequency-selection-prayer').click()
      .dataCy('frequency-weekly').click()
      .saveDrawer()
    cy.createOther({ name: 'Mallorn' })
      .dataCy('frequency-selection-prayer').click()
      .dataCy('frequency-annually').click()
      .saveDrawer()
    cy.createOther({ name: 'The One Ring' })
      .dataCy('frequency-selection-prayer').click()
      .dataCy('frequency-daily').click()
      .saveDrawer()

    cy.dataCy('page-prayer').click()
    cy.dataCy('list-item').eq(0).contains('One Ring')
    cy.dataCy('list-item').eq(1).contains('Athelas')
    cy.dataCy('list-item').eq(2).contains('Mallorn')
  });

  it('can add and edit tags', () => {
    cy.createPerson({ firstName: 'Frodo' })
      .addTag('Hobbit')
      .saveDrawer()
    cy.createPerson({ firstName: 'Pippin' })
      .addTag('h')
      .saveDrawer()
    cy.createPerson({ firstName: 'Boromir' })
      .addTag('h')
      .addTag('h')  // should remove the tag "Hobbit"
      .addTag('Gondor')
      .saveDrawer()
    cy.contains('Pippin').click()
      .addTag('Gon')
      .saveDrawer();

    cy.dataCy('tag')
      .filter((i, e) => /gondor/i.test(e.innerText))
      .should('have.length', 2)
    cy.dataCy('tag')
      .filter((i, e) => /hobbit/i.test(e.innerText))
      .should('have.length', 2)
  });

  it('opening/closing nested drawers works correctly', () => {
    // Requires "desktop" width for testing the permanent-drawer mechanics
    cy.viewport(1280, 720)

    // Create some test items
    cy.createGroup({ name: 'Fellowship of the Ring' })
      .saveDrawer()
    cy.createPerson({ firstName: 'Bilbo', lastName: 'Baggins' })
    cy.createPerson({ firstName: 'Frodo', lastName: 'Baggins' })
      .addToGroup('Fellowship')

    // Open a nested drawer and edit it
    cy.contains('Fellowship').click()
    cy.dataCy('description')
      .last()
      .type('Nine vs. nine, who will win?')
      .saveDrawer()

    // Open a different drawer
    cy.contains('Bilbo').click()

    // Bilbo's drawer should not be stacked so we should now be able to change pages
    cy.dataCy('page-prayer').click()

    // Check prayer report for Bilbo
    cy.dataCy('page-content')
      .contains('Bilbo')
      .click()
    cy.dataCy('drawer-content')
      .contains('Bilbo Baggins')
    cy.dataCy('drawer-content')
      .find('[data-cy=firstName]')
      .should('not.exist')

    // Add a prayer point for Bilbo
    cy.dataCy('edit-item-button')
      .click()
    cy.dataCy('firstName')
    cy.dataCy('section-prayer-points').click()
    cy.addNote({ type: 'prayer', content: 'Safe travels' })
      .saveDrawer()
    cy.dataCy('drawer-content')
      .first()
      .contains('Safe travels')

    // Switch to Frodo (should not nest drawer)
    cy.contains('Frodo').click()
    cy.dataCy('drawer-content')
      .first()
      .contains('Bilbo')
      .should('not.exist')
  })

  it('apply default maturity levels and edit maturity settings', () => {
    cy.createPerson({ firstName: 'Frodo', lastName: 'Baggins' })
    cy.dataCy('maturity-selection')
      .click()
    cy.contains(/non-Christian/i)
      .click()
      .saveDrawer()
    cy.dataCy('page-settings').click()
    cy.dataCy('maturity-stages')
      .find('[data-cy=edit-button]')
      .click()

    // Check order swapping
    cy.dataCy('maturity-move-up').first()
      .should('be.disabled')
    cy.dataCy('maturity-move-down').last()
      .should('be.disabled')
    cy.dataCy('maturity-move-down').eq(1)
      .click()
    cy.dataCy('maturity-move-up').eq(1)
      .click()
    cy.dataCy('maturity-stage-name').find('input').first()
      .should('have.value', 'Mature Christian')
    cy.dataCy('maturity-stage-name').find('input').last()
      .should('have.value', 'Young Christian')

    // Remove, add, and edit some stages
    cy.dataCy('maturity-remove-stage')
      .eq(1).click()
    cy.dataCy('maturity-add-stage').click()
    cy.dataCy('maturity-stage-name').last()
      .find('input').should('be.focused')
      .type('Partner')
    cy.dataCy('maturity-stage-name').first()
      .clear()
      .type('Attended')
    cy.dataCy('maturity-stage-name').eq(1)
      .clear()
      .type('Regular')
    cy.dataCy('maturity-done').click()
    cy.dataCy('page-content').contains('Christian').should('not.exist')
    cy.dataCy('page-content').find('[data-cy=tag]').as('stages')
    cy.get('@stages').eq(0).contains('Attended')
    cy.get('@stages').eq(1).contains('Regular')
    cy.get('@stages').eq(2).contains('Partner')

    // Previous maturity selection should not exist
    cy.dataCy('page-people').click()
    cy.contains('Frodo').click()
    cy.dataCy('maturity-selection').find('input').should('have.value', '')

    // Choose one of the new maturity values
    cy.dataCy('maturity-selection').click()
    cy.contains('Non-Christian').should('not.exist')
    cy.contains('Partner').click()
  })

  it('renaming a maturity state updates everyone who is at that stage', () => {
    cy.viewport(1280, 720)

    cy.createPerson({ firstName: 'Frodo' })
    cy.dataCy('maturity-selection').click()
    cy.contains(/young Christian/i).click()
    cy.createPerson({ firstName: 'Pippin' })
    cy.dataCy('maturity-selection').click()
    cy.contains(/young Christian/i).click()
    cy.createPerson({ firstName: 'Bilbo' })
    cy.dataCy('maturity-selection').click()
    cy.contains(/mature Christian/i).click()

    cy.dataCy('page-settings').click()
    cy.dataCy('maturity-stages')
      .find('[data-cy=edit-button]')
      .click()
    cy.dataCy('maturity-stage-name').eq(1)
      .clear()
      .type('Youngster')
    cy.dataCy('maturity-done').click()

    cy.dataCy('page-people').click()
    cy.contains('Frodo').click()
    cy.dataCy('maturity-selection').find('input').should('have.value', 'Youngster')
    cy.contains('Pippin').click()
    cy.dataCy('maturity-selection').find('input').should('have.value', 'Youngster')
    cy.contains('Bilbo').click()
    cy.dataCy('maturity-selection').find('input').should('have.value', 'Mature Christian')
  })
})

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
});

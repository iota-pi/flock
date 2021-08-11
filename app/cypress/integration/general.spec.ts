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
      .addNote({ content: 'Trim the hedges', type: 'action' })
      .addNote({ content: 'Cook taters', type: 'action' })
      .addNote({ content: 'Bully Gollum', type: 'action', sensitive: true })
      .saveDrawer()
    cy.dataCy('page-actions').click()
    cy.dataCy('page-content')
      .contains('Frodo Baggins')
    cy.dataCy('page-content')
      .contains('Trim the hedges')
    cy.dataCy('page-content')
      .contains('Cook taters')
    cy.dataCy('page-content')
      .contains('Bully gollum')
      .should('not.exist')
  });

  it('can create groups; add & remove members', () => {
    cy.createPerson({ firstName: 'Frodo', lastName: 'Baggins' })
      .saveDrawer()
    cy.createPerson({ firstName: 'Peregrin', lastName: 'Took' })
      .saveDrawer()
    cy.createPerson({ firstName: 'Meriadoc', lastName: 'Brandybuck' })
      .saveDrawer()
    cy.createGroup({ name: 'The Fellowship of the Ring' })
      .addMember('Frodo')
      .addMember('Peregrin')
      .addMember('Meriadoc')
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

  it('can create groups; add & remove members', () => {
    cy.createPerson({ firstName: 'Frodo', lastName: 'Baggins' })
      .saveDrawer()
    cy.createPerson({ firstName: 'Peregrin', lastName: 'Took' })
      .saveDrawer()
    cy.createPerson({ firstName: 'Meriadoc', lastName: 'Brandybuck' })
      .saveDrawer()
    cy.createGroup({ name: 'The Fellowship of the Ring' })
      .addMember('Frodo')
      .addMember('Peregrin')
      .addMember('Meriadoc')
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
});

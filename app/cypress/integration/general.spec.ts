describe('create account', () => {
  beforeEach(() => {
    cy.visit('http://localhost:3000')
    cy.createAccount('wellthisisverysecureisn\'tit?');
  });

  it('can create and edit items', () => {
    cy.createPerson({
      firstName: 'Frodo',
      lastName: 'Baggins',
    })
    cy.reload()
    cy.dataCy('page-content')
      .contains('Frodo Baggins')
      .click()
    cy.dataCy('description').type('aka. Mr. Underhill')
    cy.saveDrawer()
    cy.dataCy('page-content')
      .contains('Underhill')
  });
});

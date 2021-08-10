import { PersonItem } from '../../src/state/items';

Cypress.Commands.add('dataCy', (dataCy: string) => {
  return cy.get(`[data-cy=${dataCy}]`)
});

Cypress.Commands.add('createAccount', (password: string) => {
  cy.dataCy('create-account').click()
  cy.get('#password').type(password)
  cy.dataCy('create-account').click()
  cy.get('#current-password').type(password)
  cy.dataCy('login').click()
});

Cypress.Commands.add(
  'login',
  ({ username, password }: { username: string, password: string }) => {
    cy.get('#username').type(username)
    cy.get('#current-password').type(password)
    cy.dataCy('login').click()
  },
);

Cypress.Commands.add(
  'createPerson',
  (data: Partial<PersonItem>) => {
    cy.dataCy('page-people').click()
    cy.dataCy('fab').click()
    for (const key of Object.keys(data)) {
      cy.dataCy(key).type(data[key])
    }
    cy.saveDrawer();
  },
);

Cypress.Commands.add(
  'saveDrawer',
  (data: Partial<PersonItem>) => {
    cy.intercept({ method: 'PUT', url: '/*/items/*', times: 1 }).as('apiRequest')
    cy.dataCy('drawer-done').click()
    cy.wait(['@apiRequest']);
  },
);

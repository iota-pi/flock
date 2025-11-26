import { GroupItem, PersonItem } from '../../src/state/items';
import 'cypress-file-upload';

Cypress.Commands.overwrite('type', (originalFn, element, text, options = {}) => {
  options.delay = 5;
  return originalFn(element, text, options);
})

Cypress.Commands.add('dataCy', (dataCy: string) => {
  return cy.get(`[data-cy=${dataCy}]`)[0]
});

Cypress.Commands.add('createAccount', (password: string) => {
  cy.dataCy('create-account').click()
  cy.get('#password').type(password)
  cy.get('#confirm-password').type(password)
  cy.dataCy('create-account').click()
  cy.get('#current-password').type(password)
  cy.intercept({ method: 'GET', url: '/*', times: 2 }).as('apiRequest')
  cy.dataCy('login').click()
  cy.wait(['@apiRequest'])
  return cy;
});

Cypress.Commands.add(
  'login',
  ({ username, password }: { username: string, password: string }) => {
    cy.get('#username').type(username)
    cy.get('#current-password').type(password)
    cy.intercept({ method: 'GET', url: '/*', times: 2 }).as('apiRequest')
    cy.dataCy('login').click()
    cy.wait(['@apiRequest'])
    return cy;
  },
);

Cypress.Commands.add(
  'page',
  (page: string) => {
    cy.dataCy(`page-${page}`).click({ force: true })
    cy.location('pathname').should('equal', '/' + page.replace('people', ''))
    return cy;
  },
);

Cypress.Commands.add(
  'createPerson',
  (data: Partial<PersonItem>) => {
    cy.page('people')
    cy.dataCy('fab').click()
    for (const key of Object.keys(data)) {
      cy.dataCy(key).type(data[key])
    }
    return cy;
  },
);

Cypress.Commands.add(
  'createGroup',
  (data: Partial<GroupItem>) => {
    cy.page('groups')
    cy.dataCy('fab').click()
    for (const key of Object.keys(data)) {
      cy.dataCy(key).type(data[key])
    }
    return cy;
  },
);

Cypress.Commands.add(
  'addToGroup',
  (group: string) => {
    cy.dataCy('groups').type(`${group}{enter}`)
    return cy;
  },
);

Cypress.Commands.add(
  'addMember',
  (name: string) => {
    cy.dataCy('members').type(`${name}{enter}`)
    return cy;
  },
);

Cypress.Commands.add(
  'saveDrawer',
  () => {
    cy.intercept({ method: 'PUT', url: '/*/items/*', times: 1 }).as('apiRequest')
    cy.dataCy('drawer-done')
      .last()
      .click()
    cy.wait(['@apiRequest'])
    return cy;
  },
);

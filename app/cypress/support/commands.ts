import { GroupItem, ItemNote, PersonItem } from '../../src/state/items';

Cypress.Commands.add('dataCy', (dataCy: string) => {
  return cy.get(`[data-cy=${dataCy}]`)
});

Cypress.Commands.add('createAccount', (password: string) => {
  cy.dataCy('create-account').click()
  cy.get('#password').type(password)
  cy.dataCy('create-account').click()
  cy.get('#current-password').type(password)
  cy.dataCy('login').click()
  return cy;
});

Cypress.Commands.add(
  'login',
  ({ username, password }: { username: string, password: string }) => {
    cy.get('#username').type(username)
    cy.get('#current-password').type(password)
    cy.dataCy('login').click()
    return cy;
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
    return cy;
  },
);

Cypress.Commands.add(
  'createGroup',
  (data: Partial<GroupItem>) => {
    cy.dataCy('page-groups').click()
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
  'addNote',
  (note: Pick<ItemNote, 'content' | 'type' | 'sensitive'>) => {
    cy.dataCy(`add-${note.type}`).click()
    if (note.content) {
      cy.focused().type(note.content)
    }
    if (note.sensitive) {
      cy.dataCy(`sensitive-note`).first().click()
    }
    return cy;
  },
);

Cypress.Commands.add(
  'saveDrawer',
  () => {
    cy.intercept({ method: 'PUT', url: '/*/items/*', times: 1 }).as('apiRequest')
    cy.dataCy('drawer-done').click()
    cy.wait(['@apiRequest']);
    return cy;
  },
);

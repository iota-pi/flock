/// <reference types="cypress" />
import { GroupItem, PersonItem } from '../../src/state/items';

declare global {
  namespace Cypress {
    interface Chainable {
      /**
       * Custom command to select DOM element by data-cy attribute.
       * @example cy.dataCy('greeting')
       */
      dataCy(value: string): Chainable<Element>;

      createAccount(password: string): Chainable;
      login(credentials: { username: string, password: string }): Chainable;
      page(page: string): Chainable;

      createPerson(data: Partial<PersonItem>): Chainable;
      createGroup(data: Partial<GroupItem>): Chainable;
      saveDrawer(): Chainable;

      addTag(tag: string): Chainable;
      addToGroup(group: string): Chainable;
      addMember(name: string): Chainable;
    }
  }
}

import './commands';

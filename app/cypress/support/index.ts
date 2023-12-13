// ***********************************************************
// This example support/index.js is processed and
// loaded automatically before your test files.
//
// This is a great place to put global configuration and
// behavior that modifies Cypress.
//
// You can change the location of this file or turn off
// automatically serving support files with the
// 'supportFile' configuration option.
//
// You can read more here:
// https://on.cypress.io/configuration
// ***********************************************************
/// <reference types="cypress" />
import { GeneralItem, GroupItem, PersonItem } from '../../src/state/items';

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
      createOther(data: Partial<GeneralItem>): Chainable;
      saveDrawer(): Chainable;

      addTag(tag: string): Chainable;
      addToGroup(group: string): Chainable;
      addMember(name: string): Chainable;
    }
  }
}

import './commands';

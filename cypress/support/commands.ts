import type { PageId } from '../../src/components/pages/types'
import {
  getBlankGroup,
  getBlankPerson,
  type GroupItem,
  type PersonItem,
} from '../../src/state/items'

type NetworkMode = 'online' | 'offline' | 'server-error'

const TRPC_MUTATION_PATTERNS = [
  '**/trpc/items.put*',
  '**/trpc/items.putMany*',
  '**/trpc/accounts.updateMetadata*',
]

function getMutationAliasFromUrl(url: string, mode: NetworkMode): string {
  if (url.includes('/trpc/items.putMany')) {
    return mode === 'offline' ? 'offlinePutMany' : mode === 'server-error' ? 'errorPutMany' : 'onlinePutMany'
  }

  if (url.includes('/trpc/accounts.updateMetadata')) {
    return mode === 'offline' ? 'offlineUpdateMetadata' : mode === 'server-error' ? 'errorUpdateMetadata' : 'onlineUpdateMetadata'
  }

  return mode === 'offline' ? 'offlinePut' : mode === 'server-error' ? 'errorPut' : 'onlinePut'
}

function ensureNetworkInterceptors() {
  if (Cypress.env('NETWORK_INTERCEPTORS_READY')) {
    return
  }

  TRPC_MUTATION_PATTERNS.forEach(pattern => {
    cy.intercept('POST', pattern, req => {
      const mode = (Cypress.env('NETWORK_MODE') as NetworkMode | undefined) || 'online'
      req.alias = getMutationAliasFromUrl(req.url, mode)

      if (mode === 'offline') {
        req.reply({ forceNetworkError: true })
        return
      }

      if (mode === 'server-error') {
        req.reply({
          statusCode: 500,
          body: { error: 'Internal Server Error' },
        })
        return
      }

      req.continue()
    })
  })

  Cypress.env('NETWORK_INTERCEPTORS_READY', true)
}

function readSyncDbKey<T>(win: Cypress.AUTWindow, key: string): Promise<T | null> {
  return new Cypress.Promise((resolve, reject) => {
    const request = win.indexedDB.open('FlockVaultDB')

    request.onerror = () => {
      reject(request.error || new Error(`Failed to open IndexedDB: ${key}`))
    }

    request.onsuccess = () => {
      const db = request.result
      try {
        const transaction = db.transaction('keyvaluepairs', 'readonly')
        const store = transaction.objectStore('keyvaluepairs')
        const valueRequest = store.get(key)

        valueRequest.onerror = () => {
          reject(valueRequest.error || new Error(`Failed to read IndexedDB key: ${key}`))
          db.close()
        }

        valueRequest.onsuccess = () => {
          resolve((valueRequest.result as T | undefined) ?? null)
          db.close()
        }
      } catch (error) {
        db.close()
        reject(error)
      }
    }
  })
}


Cypress.Commands.add('dataCy', (...dataCy: string[]) => (
  cy.get(dataCy.map(id => `[data-cy="${id}"]`).join(','))
))

Cypress.Commands.add('goOffline', () => {
  cy.log('**Going Offline**')
  Cypress.env('NETWORK_MODE', 'offline')
  ensureNetworkInterceptors()
  return cy
})

Cypress.Commands.add('goOnline', () => {
  cy.log('**Going Online**')
  Cypress.env('NETWORK_MODE', 'online')
  ensureNetworkInterceptors()
  return cy
})

Cypress.Commands.add('forceServerError', () => {
  cy.log('**Forcing 500 Server Error**')
  Cypress.env('NETWORK_MODE', 'server-error')
  ensureNetworkInterceptors()
  return cy
})

Cypress.Commands.add('getOfflineQueue', () => {
  return cy.window().then(win => readSyncDbKey<unknown[]>(win, 'mutations').then(queue => queue || []))
})

Cypress.Commands.add('getDeadLetterQueue', () => {
  return cy.window().then(win => readSyncDbKey<unknown[]>(win, 'dead-letter-mutations').then(queue => queue || []))
})

Cypress.Commands.add('ensureAccount', (password: string): Cypress.Chainable<string> => {
  const existing = Cypress.env('TEST_ACCOUNT_ID') as string | undefined
  if (existing) {
    return cy.wrap(existing, { log: false })
  }

  cy.visit('/')
  cy.createAccount(password)

  cy.location('pathname').should('equal', '/')

  return cy
    .window()
    .its('localStorage')
    .invoke('getItem', 'FlockVaultAccount')
    .should('be.a', 'string')
    .then(accountId => {
      if (!accountId) throw new Error('Account ID not found after account creation')
      Cypress.env('TEST_ACCOUNT_ID', accountId)
      return accountId
    })
})

Cypress.Commands.add('createAccount', (password: string): Cypress.Chainable => {
  cy.dataCy('create-account').click()
  cy.get('#password').type(password)
  cy.dataCy('create-account').click()
  cy.dataCy('acknowledge-account-id').check({ force: true })
  cy.dataCy('continue-button').click()
  cy.get('#current-password').type(password)
  cy.intercept({ method: 'GET', url: '**/*' }).as('initialFetch')
  cy.dataCy('login').click()
  cy.wait('@initialFetch')
  return cy
})

Cypress.Commands.add(
  'page',
  (page: PageId): Cypress.Chainable => {
    cy.dataCy(`page-${page}`).click({ force: true })
    const expectedPath = page === 'prayer' ? '/' : `/${page}`
    cy.location('pathname').should('equal', expectedPath)
    cy.dataCy(`page-content-${page}`).should('exist')
    cy.dataCy('loading-progress').should('not.be.visible')
    return cy
  },
)

Cypress.Commands.add(
  'createPerson',
  (data: Partial<PersonItem>, manual = false): Cypress.Chainable => {
    if (manual) {
      cy.page('people')
      cy.dataCy('fab').click()
      Object.entries(data).forEach(([key, value]) => {
        if (key.includes('Frequency') && value !== undefined) {
          cy.dataCy(key).click()
          cy.dataCy(`frequency-${value}`).click()
        } else if (value !== undefined) {
          cy.dataCy(key).clear().type(String(value))
        }
      })
      return cy
    } else {
      return cy.window().then(win => {
        return win.mutations.then(mutations => {
          const person = {
            ...getBlankPerson(undefined, false),
            ...data,
          }
          return mutations.mutateStoreItems(person)
        })
      })
    }
  },
)

Cypress.Commands.add(
  'createGroup',
  (data: Partial<GroupItem>, manual = false): Cypress.Chainable => {
    if (manual) {
      cy.page('groups')
      cy.dataCy('fab').click()
      Object.entries(data).forEach(([key, value]) => {
        if (key.includes('Frequency') && value !== undefined) {
          cy.dataCy(key).click()
          cy.dataCy(`frequency-${value}`).click()
        } else if (value !== undefined) {
          cy.dataCy(key).clear().type(String(value))
        }
      })
      return cy
    } else {
      return cy.window().then(win => {
        return win.mutations.then(mutations => {
          const group = {
            ...getBlankGroup(undefined, false),
            ...data,
          }
          return mutations.mutateStoreItems(group)
        })
      })
    }
  },
)

Cypress.Commands.add(
  'addToGroup',
  (group: string): Cypress.Chainable => {
    cy.dataCy('groups').type(`${group}{enter}`)
    cy.get('body').type('{esc}')
    return cy
  },
)

Cypress.Commands.add(
  'addMember',
  (name: string): Cypress.Chainable => {
    cy.dataCy('members').type(`${name}{enter}`)
    cy.get('body').type('{esc}')
    return cy
  },
)

Cypress.Commands.add(
  'saveDrawer',
  (): Cypress.Chainable => {
    return cy.dataCy('drawer-done').last().then($button => {
      const shouldWait = $button.text().toLowerCase().includes('save')

      if (shouldWait) {
        cy.intercept({ method: /PUT|POST/, url: '**/trpc/items.put*' }).as('saveItem')
        cy.intercept({ method: /PUT|POST/, url: '**/trpc/items.putMany*' }).as('saveItem')
      }

      cy.wrap($button).click()

      if (shouldWait) {
        cy.wait('@saveItem')
      }

      return cy
    })
  },
)

Cypress.Commands.add(
  'invalidateQuery',
  (key: AppQueryKey): Cypress.Chainable => {
    return cy.window({ log: false }).then(win => {
      if (!win.invalidateQuery) {
        throw new Error('invalidateQuery function not found on window object')
      }
      return win.invalidateQuery(key)
    })
  },
)

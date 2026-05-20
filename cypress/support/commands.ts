import type { PageId } from '../../src/components/pages/types'
import { GroupItem, PersonItem } from '../../src/shared/schemas/items'

function generateLocalItemId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

function makeBlankPerson(): PersonItem {
  return {
    id: generateLocalItemId(),
    type: 'person',
    name: '',
    description: '',
    created: Date.now(),
    archived: false,
    prayedFor: [],
    prayerFrequency: 'none',
    notes: [],
    isNew: undefined,
  }
}

function makeBlankGroup(): GroupItem {
  return {
    id: generateLocalItemId(),
    type: 'group',
    name: '',
    description: '',
    created: Date.now(),
    archived: false,
    prayedFor: [],
    prayerFrequency: 'none',
    notes: [],
    members: [],
    memberPrayerFrequency: 'none',
    memberPrayerTarget: 'one',
    isNew: undefined,
  }
}

type NetworkMode = 'online' | 'offline' | 'server-error'

const TRPC_MUTATION_PATTERNS = [
  '**/trpc/items.put*',
  '**/trpc/items.putMany*',
  '**/trpc/accounts.updateMetadata*',
]

const REST_MUTATION_PATTERNS = [
  '**/items',
  '**/items/**',
  '**/metadata',
]

function getMutationAliasFromUrl(url: string, mode: NetworkMode): string {
  if (url.includes('/trpc/items.putMany')) {
    return mode === 'offline' ? 'offlinePutMany' : mode === 'server-error' ? 'errorPutMany' : 'onlinePutMany'
  }

  if (url.includes('/items') && !url.includes('/trpc/')) {
    return mode === 'offline' ? 'offlinePut' : mode === 'server-error' ? 'errorPut' : 'onlinePut'
  }

  if (url.includes('/trpc/accounts.updateMetadata')) {
    return mode === 'offline' ? 'offlineUpdateMetadata' : mode === 'server-error' ? 'errorUpdateMetadata' : 'onlineUpdateMetadata'
  }

  if (url.includes('/metadata') && !url.includes('/trpc/')) {
    return mode === 'offline' ? 'offlineUpdateMetadata' : mode === 'server-error' ? 'errorUpdateMetadata' : 'onlineUpdateMetadata'
  }

  return mode === 'offline' ? 'offlinePut' : mode === 'server-error' ? 'errorPut' : 'onlinePut'
}

function ensureNetworkInterceptors() {
  if (Cypress.expose('NETWORK_INTERCEPTORS_READY')) {
    return
  }

  TRPC_MUTATION_PATTERNS.forEach(pattern => {
    cy.intercept('POST', pattern, req => {
      const mode = (Cypress.expose('NETWORK_MODE') as NetworkMode | undefined) || 'online'
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

  REST_MUTATION_PATTERNS.forEach(pattern => {
    cy.intercept({ method: /PUT|POST/, url: pattern }, req => {
      const mode = (Cypress.expose('NETWORK_MODE') as NetworkMode | undefined) || 'online'
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

  Cypress.expose('NETWORK_INTERCEPTORS_READY', true)
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

function readStoredAccountId(localStorageRef: Storage): string | null {
  const serializedMeta = localStorageRef.getItem('FlockVaultMeta')
  if (serializedMeta) {
    try {
      const parsed = JSON.parse(serializedMeta) as { account?: unknown }
      if (typeof parsed.account === 'string' && parsed.account.length > 0) {
        return parsed.account
      }
    } catch {
      // Ignore malformed storage and fall back to legacy account key.
    }
  }

  const legacyAccount = localStorageRef.getItem('FlockVaultAccount')
  return typeof legacyAccount === 'string' && legacyAccount.length > 0 ? legacyAccount : null
}


Cypress.Commands.add('dataCy', (...dataCy: string[]) => (
  cy.get(dataCy.map(id => `[data-cy="${id}"]`).join(','))
))

Cypress.Commands.add('goOffline', () => {
  cy.log('**Going Offline**')
  Cypress.expose('NETWORK_MODE', 'offline')
  ensureNetworkInterceptors()
  return cy
})

Cypress.Commands.add('goOnline', () => {
  cy.log('**Going Online**')
  Cypress.expose('NETWORK_MODE', 'online')
  ensureNetworkInterceptors()
  return cy
})

Cypress.Commands.add('forceServerError', () => {
  cy.log('**Forcing 500 Server Error**')
  Cypress.expose('NETWORK_MODE', 'server-error')
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
  const existing = Cypress.expose('TEST_ACCOUNT_ID') as string | undefined
  if (typeof existing === 'string' && existing.length > 0) {
    cy.visit('/login')
    cy.get('#username', { timeout: 15000 }).clear().type(existing)
    cy.get('#current-password').clear().type(password)
    cy.dataCy('login').click()
    cy.location('pathname', { timeout: 15000 }).should('equal', '/')
    return cy.wrap(existing, { log: false })
  }

  cy.visit('/welcome')
  cy.createAccount(password)

  cy.location('pathname').should('equal', '/')

  return cy
    .window()
    .its('localStorage')
    .then(localStorageRef => {
      const stableAccountId = readStoredAccountId(localStorageRef) || 'session-account'
      Cypress.expose('TEST_ACCOUNT_ID', stableAccountId)
      return stableAccountId
    })
})

Cypress.Commands.add('createAccount', (password: string): Cypress.Chainable => {
  cy.dataCy('create-account').click()
  cy.get('#password').type(password)
  cy.dataCy('create-account').click()
  cy.dataCy('acknowledge-account-id').check({ force: true })
  cy.dataCy('continue-button').click()
  cy.get('#current-password').type(password)
  cy.dataCy('login').click()
  cy.location('pathname', { timeout: 15000 }).should('equal', '/')
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
      cy.dataCy('fab').click({ force: true })
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
        const mutations = win.mutations
        if (!mutations) {
          throw new Error('Expected mutations API to be available on window')
        }

        return mutations.then(mutationsApi => {
          const person = {
            ...makeBlankPerson(),
            ...data,
          }
          return mutationsApi.storeItems(person)
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
      cy.dataCy('fab').click({ force: true })
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
        const mutations = win.mutations
        if (!mutations) {
          throw new Error('Expected mutations API to be available on window')
        }

        return mutations.then(mutationsApi => {
          const group = {
            ...makeBlankGroup(),
            ...data,
          }
          return mutationsApi.storeItems(group)
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
      const networkMode = (Cypress.expose('NETWORK_MODE') as NetworkMode | undefined) || 'online'
      const shouldWaitForNetwork = shouldWait && networkMode !== 'offline'

      if (shouldWaitForNetwork) {
        cy.intercept({ method: /PUT|POST/, url: '**/trpc/items.put*' }).as('saveItem')
        cy.intercept({ method: /PUT|POST/, url: '**/trpc/items.putMany*' }).as('saveItem')
      }

      cy.wrap($button).click()

      if (shouldWaitForNetwork) {
        cy.wait(200, { log: false })
        cy.get('@saveItem.all').then(requests => {
          if (Array.isArray(requests) && requests.length > 0) {
            cy.wait('@saveItem').then(interception => {
              const statusCode = interception.response?.statusCode || 0
              const body = interception.response?.body as { error?: unknown; result?: { data?: unknown } } | undefined

              if (statusCode >= 400) {
                throw new Error(`Save request failed with status ${statusCode}: ${JSON.stringify(body)}`)
              }

              const trpcData = body?.result?.data as { success?: boolean; error?: unknown } | undefined
              if (trpcData && trpcData.success === false) {
                throw new Error(`Save request returned unsuccessful result: ${JSON.stringify(trpcData)}`)
              }
            })
          } else {
            cy.wait(800, { log: false })
          }
        })
      }

      return cy
    })
  },
)

import localforage from 'localforage'

export const syncDB = localforage.createInstance({ name: 'FlockVaultDB' })

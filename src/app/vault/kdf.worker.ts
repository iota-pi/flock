/// <reference lib="webworker" />
import { exposeKdfWorker } from '@vault/client/kdfWorker'

// Derives Argon2id keys off the main thread. Each derivation gets a fresh worker (see `createKdfWorker`).
exposeKdfWorker()

import type { ReencryptStage } from './types'

const WAIT_DESCRIPTIONS: Record<Exclude<ReencryptStage, 'reencrypting'>, string> = {
  waitingForLeader: 'Re-encryption stopped waiting for this tab to become the one that syncs',
  waitingForSync: 'Re-encryption stopped waiting for sync to allow uploads',
}

/**
 * A re-encryption that gave up waiting before it changed anything. Comlink passes only an error's
 * name and message across, so the stage is read back from the message.
 */
export class ReencryptionWaitError extends Error {
  constructor(readonly stage: Exclude<ReencryptStage, 'reencrypting'>) {
    super(WAIT_DESCRIPTIONS[stage])
    this.name = 'ReencryptionWaitError'
  }
}

/** The stage a `ReencryptionWaitError` gave up in, including one rebuilt by Comlink, or null */
export function reencryptionWaitStage(error: unknown): Exclude<ReencryptStage, 'reencrypting'> | null {
  if (!(error instanceof Error) || error.name !== 'ReencryptionWaitError') return null
  if (error instanceof ReencryptionWaitError) return error.stage
  const entry = Object.entries(WAIT_DESCRIPTIONS).find(([, message]) => message === error.message)
  return entry ? entry[0] as Exclude<ReencryptStage, 'reencrypting'> : null
}

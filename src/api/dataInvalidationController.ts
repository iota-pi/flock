import { useAuthStore } from '../state/authStore'
import { ensureMetadataLoaded } from './itemReadService'
import { subscribeDomainEvents } from '../events/domainEvents'

const METADATA_REALTIME_INVALIDATION_COOLDOWN_MS = 10 * 1000
let lastRealtimeMetadataInvalidationAt = 0

export function startDataInvalidationController(): () => void {
  return subscribeDomainEvents(event => {
    if (event.type !== 'data:updated' || event.domain !== 'metadata') {
      return
    }

    if (event.reason === 'realtime:event') {
      const now = Date.now()
      const elapsed = now - lastRealtimeMetadataInvalidationAt
      if (elapsed < METADATA_REALTIME_INVALIDATION_COOLDOWN_MS) {
        return
      }

      lastRealtimeMetadataInvalidationAt = now
    }

    const account = useAuthStore.getState().account
    if (!account) {
      return
    }

    void ensureMetadataLoaded(account, { force: true })
  })
}

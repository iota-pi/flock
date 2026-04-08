import { getQueryKey } from '@trpc/react-query'
import { queryClient } from './queryClient'
import { trpc } from './trpc'
import { subscribeDomainEvents } from '../events/domainEvents'

const METADATA_REALTIME_INVALIDATION_COOLDOWN_MS = 10 * 1000
let lastRealtimeMetadataInvalidationAt = 0

export function startDataInvalidationController(): () => void {
  return subscribeDomainEvents(event => {
    if (
      event.type === 'data:updated'
      && event.domain === 'items'
    ) {
      void queryClient.invalidateQueries({ queryKey: getQueryKey(trpc.items.fetchMany) })
      return
    }

    if (
      event.type === 'data:updated'
      && event.domain === 'metadata'
    ) {
      if (event.reason === 'realtime:event') {
        const now = Date.now()
        const elapsed = now - lastRealtimeMetadataInvalidationAt
        if (elapsed < METADATA_REALTIME_INVALIDATION_COOLDOWN_MS) {
          return
        }

        lastRealtimeMetadataInvalidationAt = now
      }

      void queryClient.invalidateQueries({ queryKey: getQueryKey(trpc.accounts.getMetadata) })
      return
    }

  })
}

type QueueLeaderMessage =
  | { type: 'request-leader'; tabId: string }
  | { type: 'im-leader'; tabId: string }
  | { type: 'leader-alive'; tabId: string; timestamp: number }
  | { type: 'leader-dying'; tabId: string }
  | { type: 'process-request'; tabId: string }

type QueueLeaderLockOptions = {
  account: string
  onProcessRequested: () => void
}

type QueueLeaderLockHandle = {
  isLeader: () => boolean
  requestProcessing: () => void
  stop: () => void
}

const LEADER_HEARTBEAT_INTERVAL_MS = 2000
const LEADER_STALE_MS = 7000
const ELECTION_DELAY_MS = 600

let activeHandle: QueueLeaderLockHandle | null = null
let activeKey = ''

function createTabId(): string {
  return `queue_tab_${Date.now()}_${Math.random().toString(36).slice(2)}`
}

function createQueueLeaderLock(options: QueueLeaderLockOptions): QueueLeaderLockHandle {
  const { account, onProcessRequested } = options
  const tabId = createTabId()
  const supportsBroadcastChannel = typeof BroadcastChannel !== 'undefined'
  const channelName = `flock:queue:${account}`
  const channel = supportsBroadcastChannel ? new BroadcastChannel(channelName) : null

  let stopped = false
  let leaderTabId: string | null = null
  let leaderLastSeenAt = 0
  let leader = !supportsBroadcastChannel

  let heartbeatTimer: ReturnType<typeof setInterval> | null = null
  let staleLeaderTimer: ReturnType<typeof setInterval> | null = null
  let electionTimer: ReturnType<typeof setTimeout> | null = null

  const emit = (message: QueueLeaderMessage) => {
    if (!channel) {
      return
    }
    channel.postMessage(message)
  }

  const becomeLeader = () => {
    if (stopped || leader) {
      return
    }

    leader = true
    leaderTabId = tabId
    leaderLastSeenAt = Date.now()
    emit({ type: 'im-leader', tabId })

    if (!heartbeatTimer) {
      heartbeatTimer = setInterval(() => {
        emit({ type: 'leader-alive', tabId, timestamp: Date.now() })
      }, LEADER_HEARTBEAT_INTERVAL_MS)
    }

    onProcessRequested()
  }

  const stepDownAsLeader = () => {
    if (!leader) {
      return
    }

    leader = false
    leaderTabId = null

    if (heartbeatTimer) {
      clearInterval(heartbeatTimer)
      heartbeatTimer = null
    }
  }

  const requestLeader = () => {
    emit({ type: 'request-leader', tabId })

    if (electionTimer) {
      clearTimeout(electionTimer)
    }

    electionTimer = setTimeout(() => {
      electionTimer = null
      if (stopped || leader) {
        return
      }

      const leaderIsFresh = leaderLastSeenAt > 0 && Date.now() - leaderLastSeenAt < LEADER_STALE_MS
      if (!leaderIsFresh) {
        becomeLeader()
      }
    }, ELECTION_DELAY_MS)
  }

  const handleMessage = (message: QueueLeaderMessage) => {
    if (message.tabId === tabId) {
      return
    }

    if (message.type === 'request-leader') {
      if (leader) {
        emit({ type: 'im-leader', tabId })
      }
      return
    }

    if (message.type === 'im-leader') {
      leaderTabId = message.tabId
      leaderLastSeenAt = Date.now()
      if (leader && message.tabId !== tabId) {
        stepDownAsLeader()
      }
      return
    }

    if (message.type === 'leader-alive') {
      leaderTabId = message.tabId
      leaderLastSeenAt = message.timestamp
      if (leader && message.tabId !== tabId) {
        stepDownAsLeader()
      }
      return
    }

    if (message.type === 'leader-dying') {
      if (leaderTabId === message.tabId) {
        leaderTabId = null
        leaderLastSeenAt = 0
        requestLeader()
      }
      return
    }

    if (message.type === 'process-request' && leader) {
      onProcessRequested()
    }
  }

  if (channel) {
    channel.onmessage = event => {
      handleMessage(event.data as QueueLeaderMessage)
    }
  }

  if (supportsBroadcastChannel) {
    requestLeader()

    staleLeaderTimer = setInterval(() => {
      if (stopped || leader) {
        return
      }

      const leaderIsFresh = leaderLastSeenAt > 0 && Date.now() - leaderLastSeenAt < LEADER_STALE_MS
      if (!leaderIsFresh) {
        requestLeader()
      }
    }, LEADER_HEARTBEAT_INTERVAL_MS)
  }

  return {
    isLeader: () => leader,
    requestProcessing: () => {
      if (leader) {
        onProcessRequested()
        return
      }

      emit({ type: 'process-request', tabId })
    },
    stop: () => {
      if (stopped) {
        return
      }

      stopped = true

      if (leader) {
        emit({ type: 'leader-dying', tabId })
      }

      stepDownAsLeader()

      if (staleLeaderTimer) {
        clearInterval(staleLeaderTimer)
        staleLeaderTimer = null
      }

      if (electionTimer) {
        clearTimeout(electionTimer)
        electionTimer = null
      }

      if (channel) {
        channel.close()
      }
    },
  }
}

export function startQueueLeaderLock(options: QueueLeaderLockOptions): void {
  const key = options.account
  if (activeHandle && activeKey === key) {
    return
  }

  stopQueueLeaderLock()
  activeKey = key
  activeHandle = createQueueLeaderLock(options)
}

export function stopQueueLeaderLock(): void {
  if (!activeHandle) {
    return
  }

  activeHandle.stop()
  activeHandle = null
  activeKey = ''
}

export function canProcessOfflineQueue(): boolean {
  if (!activeHandle) {
    return true
  }

  return activeHandle.isLeader()
}

export function requestQueueProcessing(): void {
  activeHandle?.requestProcessing()
}
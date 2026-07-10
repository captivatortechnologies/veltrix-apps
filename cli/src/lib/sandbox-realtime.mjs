// ============================================================================
// Sandbox realtime transport — one Socket.IO connection to the platform.
//
// The platform's realtime layer (server/src/lib/websocket-server) joins each
// socket to its tenant room `tenant:<customerId>` and publishes sandbox events
// there. The handshake accepts `auth.token` as EITHER a JWT or an API key with
// the `sandbox:read` scope; the CLI holds an API key, so it authenticates with
// that.
//
// This is the single low-level socket used by both `--logs` (live-logs.mjs)
// and reverse sync (reverse-sync-session.mjs): open once, forward the named
// events, and distinguish the first connect from later reconnects so callers
// can reconcile only when they actually need to.
//
// Degradation is deliberate: an older platform whose handshake rejects the API
// key (or which has no realtime at all) triggers `onUnavailable` exactly once,
// after which the socket is closed — the caller falls back to its one-way path
// and we never spam a rejecting handshake with retries.
// ============================================================================

import { io } from 'socket.io-client'

// After the first failed handshake, wait this long for a successful connect
// before declaring realtime unavailable. This catches BOTH failure shapes:
// a fatal middleware rejection (socket.io emits a single `connect_error` and
// never retries — e.g. a platform that doesn't accept API-key WS auth) and a
// briefly-unreachable endpoint (repeated `connect_error`s). Either way we
// report exactly once and stop, so we never spam a rejecting handshake.
const INITIAL_GRACE_MS = 2500

/**
 * @param profile  { url, apiKey }
 * @param options  {
 *   events:        string[]                     — event names to subscribe to
 *   sandboxId:     string                        — drop events for other sandboxes
 *   onEvent:       (name, payload) => void
 *   onConnected:   () => void                    — first successful connect
 *   onReconnect:   () => void                    — every reconnect after that
 *   onUnavailable: (reason) => void              — called at most once
 * }
 * @returns { close() }
 */
export function connectSandboxSocket(
  profile,
  { events = [], sandboxId, onEvent, onConnected, onReconnect, onUnavailable } = {},
) {
  let everConnected = false
  let unavailableReported = false
  let graceTimer = null

  const socket = io(profile.url, {
    transports: ['websocket'],
    auth: { token: profile.apiKey },
    reconnection: true,
    reconnectionAttempts: Infinity, // keep reconnecting for the life of the dev loop
    reconnectionDelay: 1000,
    reconnectionDelayMax: 10000,
    timeout: 8000,
  })

  const reportUnavailable = (reason) => {
    if (unavailableReported) return
    unavailableReported = true
    clearTimeout(graceTimer)
    onUnavailable?.(reason)
    socket.close()
  }

  socket.on('connect', () => {
    clearTimeout(graceTimer)
    graceTimer = null
    if (everConnected) {
      onReconnect?.()
    } else {
      everConnected = true
      onConnected?.()
    }
  })

  socket.on('connect_error', (error) => {
    // Once we have connected at least once, socket.io owns reconnection.
    if (everConnected || unavailableReported) return
    // Arm the grace window on the first failure; if we still have not
    // connected when it elapses, declare live pull unavailable (once).
    if (!graceTimer) {
      graceTimer = setTimeout(
        () => reportUnavailable(error?.message || 'connection failed'),
        INITIAL_GRACE_MS,
      )
    }
  })

  for (const name of events) {
    socket.on(name, (payload) => {
      if (payload?.sandboxId && sandboxId && payload.sandboxId !== sandboxId) return
      onEvent?.(name, payload ?? {})
    })
  }

  return {
    close() {
      unavailableReported = true // silence callbacks during shutdown
      socket.close()
    },
  }
}

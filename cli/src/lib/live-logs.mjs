// ============================================================================
// Live sandbox event streaming (`veltrix dev --logs`).
//
// The platform's realtime layer is Socket.IO (server/src/lib/websocket-server
// on the platform side) with a JWT handshake (`auth.token`) that joins the
// socket to its tenant room; the sandbox module publishes sandbox:synced /
// sandbox:status (and, once the runner lands, sandbox:log) to that room.
//
// The CLI authenticates with an API key, which today's platforms do not
// accept for the WS handshake (JWT only — API-key WS auth is tracked on the
// platform's auth-hardening backlog). We therefore connect best-effort:
// pass the API key as the handshake token, and if the handshake is refused
// or the endpoint is unreachable we report "unavailable" exactly once and
// the dev loop falls back to sync-response output. When the platform starts
// accepting CLI tokens, live logs light up with no CLI change.
// ============================================================================

import { io } from 'socket.io-client'

const SANDBOX_EVENTS = ['sandbox:log', 'sandbox:synced', 'sandbox:status']
const MAX_INITIAL_ATTEMPTS = 2

/**
 * Connect to the platform's Socket.IO endpoint and stream sandbox events.
 *
 * @param profile   { url, apiKey }
 * @param options   {
 *   sandboxId:     only forward events for this sandbox (events without a
 *                  sandboxId are forwarded too — better noisy than silent)
 *   onEvent:       (eventName, payload) => void
 *   onConnected:   () => void
 *   onUnavailable: (reason) => void   — called at most once
 * }
 * @returns { close() }
 */
export function connectLiveLogs(profile, { sandboxId, onEvent, onConnected, onUnavailable }) {
  let everConnected = false
  let unavailableReported = false
  let failedAttempts = 0

  const socket = io(profile.url, {
    transports: ['websocket'],
    auth: { token: profile.apiKey },
    reconnection: true,
    reconnectionAttempts: 3,
    reconnectionDelay: 1000,
    timeout: 8000,
  })

  const reportUnavailable = (reason) => {
    if (unavailableReported) return
    unavailableReported = true
    onUnavailable?.(reason)
    socket.close()
  }

  socket.on('connect', () => {
    everConnected = true
    onConnected?.()
  })

  socket.on('connect_error', (error) => {
    failedAttempts++
    // Give the transport a couple of tries before declaring logs unavailable,
    // but never spam retries against a handshake that rejects our token.
    if (!everConnected && failedAttempts >= MAX_INITIAL_ATTEMPTS) {
      reportUnavailable(error?.message || 'connection failed')
    }
  })

  for (const eventName of SANDBOX_EVENTS) {
    socket.on(eventName, (payload) => {
      if (payload?.sandboxId && sandboxId && payload.sandboxId !== sandboxId) return
      onEvent?.(eventName, payload ?? {})
    })
  }

  return {
    close() {
      unavailableReported = true // silence callbacks during shutdown
      socket.close()
    },
  }
}

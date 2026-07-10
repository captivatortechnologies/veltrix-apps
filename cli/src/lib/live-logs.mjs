// ============================================================================
// Live sandbox event streaming (`veltrix dev --logs` without reverse sync).
//
// A thin wrapper over the shared realtime transport (sandbox-realtime.mjs)
// that subscribes to the log/status/run-result events. When reverse sync is
// active it owns the single socket and forwards these same events, so this
// path is used only when `--no-pull` is combined with `--logs`.
//
// The CLI authenticates with an API key; if the platform's handshake rejects
// it (older platform) or the endpoint is unreachable, `onUnavailable` fires
// once and the dev loop falls back to sync-response output.
// ============================================================================

import { connectSandboxSocket } from './sandbox-realtime.mjs'

const SANDBOX_EVENTS = ['sandbox:log', 'sandbox:synced', 'sandbox:status', 'sandbox:run-result']

/**
 * @param profile   { url, apiKey }
 * @param options   { sandboxId, onEvent, onConnected, onUnavailable }
 * @returns { close() }
 */
export function connectLiveLogs(profile, { sandboxId, onEvent, onConnected, onUnavailable }) {
  return connectSandboxSocket(profile, {
    events: SANDBOX_EVENTS,
    sandboxId,
    onEvent,
    onConnected,
    onUnavailable,
  })
}

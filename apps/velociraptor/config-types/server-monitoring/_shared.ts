// Shared helpers for the Velociraptor Server Monitoring config type (singleton:
// the set of SERVER_EVENT artifacts the server runs). VQL runs over the gRPC API
// (mutual TLS); see lib/velociraptorApi.ts for the reused runVQL transport seam.
//
// >>> VERIFY AGAINST A LIVE VELOCIRAPTOR SERVER <<<
// The server-monitoring VQL and the ServerMonitoringTable value shape are the
// single swap point for this config type and live entirely in THIS file:
//   - GET_SERVER_MONITORING_VQL / setServerMonitoringVQL()  (VQL function names)
//   - ServerMonitoringConfig + buildServerMonitoring()       (value shape)
// `get_server_monitoring()` / `set_server_monitoring(value=...)` are real
// Velociraptor server functions, but the JSON SHAPE (`artifacts.artifacts`) is
// inferred — the canonical proto (ServerMonitoringTable) may capitalise the keys
// (`Artifacts`). Reconcile against a live server before production use.

import type { ComponentRef, ConnectivityRef, CredentialRef } from '@veltrixsecops/app-sdk'
import {
  createVelociraptorClient,
  resolveApiClientConfig,
  vqlQuote,
  type VelociraptorClient,
  type VqlRow,
} from '../../lib/velociraptorApi'

/** Fixed identity for the singleton server-monitoring config. */
export const SERVER_SCOPE = 'server'

// --- VQL (single swap point — VERIFY every function name below) ----------------

/**
 * Read the current server monitoring state.
 * VERIFY: `get_server_monitoring()` returns the ServerMonitoringTable as one value.
 */
export const GET_SERVER_MONITORING_VQL = 'SELECT get_server_monitoring() AS config FROM scope()'

/**
 * Set the whole server monitoring state from a JSON value.
 * VERIFY: `set_server_monitoring(value=<dict>)` replaces the ServerMonitoringTable,
 * and that `parse_json(data=<json>)` produces a value it accepts.
 */
export function setServerMonitoringVQL(valueJson: string): string {
  return `SELECT set_server_monitoring(value=parse_json(data=${vqlQuote(valueJson)})) AS config FROM scope()`
}

// --- ServerMonitoringTable value shape (VERIFY the field names) ----------------

/** A list of server event-artifact names. VERIFY: the wrapper key is `artifacts`. */
export interface ArtifactList {
  artifacts?: string[]
  [key: string]: unknown
}

/** The server monitoring config (ServerMonitoringTable). VERIFY: key `artifacts`. */
export interface ServerMonitoringConfig {
  artifacts?: ArtifactList
  [key: string]: unknown
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((v) => String(v)).filter(Boolean) : []
}

/** Deep-clone a plain config via JSON round-trip (values are JSON-serialisable). */
function cloneConfig(config: ServerMonitoringConfig | null | undefined): ServerMonitoringConfig {
  if (!config || typeof config !== 'object') return {}
  try {
    return JSON.parse(JSON.stringify(config)) as ServerMonitoringConfig
  } catch {
    return {}
  }
}

/** Pull the config object out of a get_server_monitoring() row, tolerant of shape. */
export function readServerMonitoring(rows: VqlRow[]): ServerMonitoringConfig | null {
  const row = rows[0]
  if (!row) return null
  const candidate = row['config'] ?? row['Config'] ?? row
  return candidate && typeof candidate === 'object' ? (candidate as ServerMonitoringConfig) : null
}

/** The live server event-artifact list in a config (for drift/compare). */
export function liveServerArtifacts(config: ServerMonitoringConfig | null): string[] {
  return toStringArray(config?.artifacts?.artifacts)
}

/**
 * Build the value to set: the desired server event-artifact list (empty when
 * disabled). Preserves any other keys already on the live config so we only touch
 * the artifact list. Idempotent.
 */
export function buildServerMonitoring(
  current: ServerMonitoringConfig | null | undefined,
  artifacts: string[],
  enabled: boolean,
): ServerMonitoringConfig {
  const config = cloneConfig(current)
  config.artifacts = { ...(config.artifacts ?? {}), artifacts: enabled ? artifacts : [] }
  return config
}

// --- transport ----------------------------------------------------------------

/** Read the VQL timeout (seconds) from installation settings, defaulting to 30s. */
export function vqlTimeoutMs(settings: Record<string, unknown> | undefined): number {
  const raw = settings?.['vql_timeout_seconds']
  const seconds = typeof raw === 'number' ? raw : Number(raw)
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 30_000
}

/** Build a Velociraptor client (gRPC/mTLS) from the connection's api-client config. */
export async function buildClient(
  component: ComponentRef,
  credential: CredentialRef | null | undefined,
  connectivity: ConnectivityRef | null | undefined,
  settings: Record<string, unknown> | undefined,
): Promise<VelociraptorClient> {
  const config = resolveApiClientConfig(credential, component, connectivity)
  return createVelociraptorClient(config, { timeoutMs: vqlTimeoutMs(settings) })
}

// Shared helpers for the Velociraptor Client Monitoring config type
// (deploy + rollback + drift + health). VQL runs over the gRPC API (mutual TLS);
// see lib/velociraptorApi.ts for the transport seam (the reused runVQL path).
//
// >>> VERIFY AGAINST A LIVE VELOCIRAPTOR SERVER <<<
// The client-monitoring VQL and the ClientEventTable value shape are the single
// swap point for this config type and live entirely in THIS file:
//   - GET_CLIENT_MONITORING_VQL / setClientMonitoringVQL()  (VQL function names)
//   - ClientMonitoringConfig + mergeClientMonitoring()       (value shape)
// `get_client_monitoring()` / `set_client_monitoring(value=...)` are real
// Velociraptor server functions, but the JSON SHAPE of the value they exchange
// (the top-level `artifacts.artifacts` list for all clients + the per-label
// `label_events[]` list) is inferred and MUST be reconciled against a live server
// before production use. `parse_json()` is used to hand a dict value to
// set_client_monitoring — verify it accepts a parsed dict.

import type { ComponentRef, ConnectivityRef, CredentialRef } from '@veltrixsecops/app-sdk'
import {
  createVelociraptorClient,
  resolveApiClientConfig,
  vqlQuote,
  type VelociraptorClient,
  type VqlRow,
} from '../../lib/velociraptorApi'

/** The sentinel label meaning "apply to every client" (the default event group). */
export const ALL_CLIENTS_LABEL = 'All'

/** True when a label targets all clients (empty or "all", case-insensitive). */
export function isAllClientsLabel(label: string): boolean {
  const l = String(label ?? '').trim().toLowerCase()
  return l === '' || l === 'all'
}

// --- VQL (single swap point — VERIFY every function name below) ----------------

/**
 * Read the current client monitoring state.
 * VERIFY: `get_client_monitoring()` returns the ClientEventTable as one value.
 */
export const GET_CLIENT_MONITORING_VQL = 'SELECT get_client_monitoring() AS config FROM scope()'

/**
 * Set the whole client monitoring state from a JSON value.
 * VERIFY: `set_client_monitoring(value=<dict>)` replaces the ClientEventTable, and
 * that `parse_json(data=<json>)` produces a value it accepts.
 */
export function setClientMonitoringVQL(valueJson: string): string {
  return `SELECT set_client_monitoring(value=parse_json(data=${vqlQuote(valueJson)})) AS config FROM scope()`
}

// --- ClientEventTable value shape (VERIFY the field names against a live server) -

/** A list of event-artifact names. VERIFY: the wrapper key is `artifacts`. */
export interface ArtifactList {
  artifacts?: string[]
  [key: string]: unknown
}

/** Per-label event group. VERIFY: keys `label` and `artifacts`. */
export interface LabelEvent {
  label?: string
  artifacts?: ArtifactList
  [key: string]: unknown
}

/**
 * The client monitoring config (ClientEventTable). VERIFY: `artifacts` holds the
 * "all clients" group and `label_events[]` holds the per-label groups.
 */
export interface ClientMonitoringConfig {
  artifacts?: ArtifactList
  label_events?: LabelEvent[]
  [key: string]: unknown
}

/** One authored label group parsed from a canvas item. */
export interface MonitoringGroup {
  label: string
  artifacts: string[]
  enabled: boolean
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((v) => String(v)).filter(Boolean) : []
}

/** Deep-clone a plain config via JSON round-trip (values are JSON-serialisable). */
function cloneConfig(config: ClientMonitoringConfig | null | undefined): ClientMonitoringConfig {
  if (!config || typeof config !== 'object') return {}
  try {
    return JSON.parse(JSON.stringify(config)) as ClientMonitoringConfig
  } catch {
    return {}
  }
}

/** Pull the config object out of a get_client_monitoring() row, tolerant of shape. */
export function readClientMonitoring(rows: VqlRow[]): ClientMonitoringConfig | null {
  const row = rows[0]
  if (!row) return null
  const candidate = row['config'] ?? row['Config'] ?? row
  return candidate && typeof candidate === 'object' ? (candidate as ClientMonitoringConfig) : null
}

/** The live artifact list for a given label group in a config (for drift/compare). */
export function liveArtifactsForLabel(config: ClientMonitoringConfig | null, label: string): string[] {
  if (!config) return []
  if (isAllClientsLabel(label)) return toStringArray(config.artifacts?.artifacts)
  const target = String(label).trim()
  const match = (config.label_events ?? []).find((e) => String(e.label ?? '').trim() === target)
  return toStringArray(match?.artifacts?.artifacts)
}

/**
 * Merge authored groups into the current config, producing the value to set.
 * Idempotent: the "all clients" group replaces the top-level artifact list; each
 * labelled group upserts its `label_events` entry. A disabled group is applied as
 * an empty list (its artifacts are removed) rather than deleted, so re-enabling
 * restores them from the canvas. Untouched label groups are preserved as-is.
 */
export function mergeClientMonitoring(
  current: ClientMonitoringConfig | null | undefined,
  groups: MonitoringGroup[],
): ClientMonitoringConfig {
  const config = cloneConfig(current)
  config.label_events = Array.isArray(config.label_events) ? config.label_events : []

  for (const group of groups) {
    const list = group.enabled ? group.artifacts : []
    if (isAllClientsLabel(group.label)) {
      config.artifacts = { ...(config.artifacts ?? {}), artifacts: list }
      continue
    }
    const target = group.label.trim()
    const idx = config.label_events.findIndex((e) => String(e.label ?? '').trim() === target)
    if (idx >= 0) {
      config.label_events[idx] = {
        ...config.label_events[idx],
        label: group.label,
        artifacts: { ...(config.label_events[idx].artifacts ?? {}), artifacts: list },
      }
    } else {
      config.label_events.push({ label: group.label, artifacts: { artifacts: list } })
    }
  }

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

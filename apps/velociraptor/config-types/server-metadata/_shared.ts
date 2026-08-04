// Shared helpers for the Velociraptor Server Metadata config type (singleton:
// free-form key/value tags stamped on the server itself — e.g. environment,
// owning team, compliance tier — for asset inventory / tagging, distinct from
// Server Monitoring's event-artifact table). VQL runs over the gRPC API (mutual
// TLS); see lib/velociraptorApi.ts for the reused runVQL transport seam.
//
// >>> VERIFY AGAINST A LIVE VELOCIRAPTOR SERVER <<<
// The server-metadata VQL is the single swap point for this config type and
// lives entirely in THIS file:
//   - GET_SERVER_METADATA_VQL / serverSetMetadataVQL()  (VQL function names)
// `server_metadata()` / `server_set_metadata(metadata=...)` are real
// Velociraptor server functions (vql/server/clients/metadata.go) that read/write
// a free-form key/value dict scoped to the whole server (distinct from
// `client_metadata()` / `client_set_metadata()`, which are per-client and out of
// scope here — see README Coverage). The exact column name the read wraps its
// dict in (`metadata` vs `Metadata`) is UNCERTAIN — readServerMetadata() reads it
// defensively.

import type { ComponentRef, ConnectivityRef, CredentialRef } from '@veltrixsecops/app-sdk'
import {
  createVelociraptorClient,
  resolveApiClientConfig,
  vqlJson,
  type VelociraptorClient,
  type VqlRow,
} from '../../lib/velociraptorApi'

/** Fixed identity for the singleton server-metadata config. */
export const SERVER_SCOPE = 'server'

// --- VQL (single swap point — VERIFY every function name below) ----------------

/**
 * Read the current server metadata dict.
 * VERIFY: `server_metadata()` returns the free-form key/value dict as one value.
 */
export const GET_SERVER_METADATA_VQL = 'SELECT server_metadata() AS metadata FROM scope()'

/**
 * Replace the whole server metadata dict.
 * VERIFY: `server_set_metadata(metadata=<dict>)` replaces the server metadata
 * store, and that `parse_json(data=<json>)` produces a value it accepts.
 */
export function serverSetMetadataVQL(metadata: Record<string, string>): string {
  return `SELECT server_set_metadata(metadata=${vqlJson(metadata)}) AS metadata FROM scope()`
}

// --- value shape ----------------------------------------------------------------

/** One authored key/value pair parsed from the canvas's `metadata` keyvalue field. */
export interface MetadataEntry {
  key: string
  value: string
}

/** Coerce a keyvalue field's raw object into a clean, string-valued entry list. */
export function parseMetadataEntries(value: unknown): MetadataEntry[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  const out: MetadataEntry[] = []
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const k = key.trim()
    if (!k) continue
    out.push({ key: k, value: raw == null ? '' : String(raw) })
  }
  return out
}

/** Pull the metadata dict out of a server_metadata() row, tolerant of shape. */
export function readServerMetadata(rows: VqlRow[]): Record<string, unknown> {
  const row = rows[0]
  if (!row) return {}
  const candidate = row['metadata'] ?? row['Metadata'] ?? row
  return candidate && typeof candidate === 'object' && !Array.isArray(candidate)
    ? (candidate as Record<string, unknown>)
    : {}
}

/** The live string value of one declared key (for drift/compare); "" when absent. */
export function liveMetadataValue(current: Record<string, unknown>, key: string): string | undefined {
  if (!(key in current)) return undefined
  const v = current[key]
  return v == null ? '' : String(v)
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

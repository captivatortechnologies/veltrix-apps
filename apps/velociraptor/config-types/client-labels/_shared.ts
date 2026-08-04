// Shared helpers for the Velociraptor Client Labels config type: pin a named
// label to an explicit, bounded list of client ids (e.g. "vip-servers" ->
// [C.1a2b..., C.3c4d...]). VQL runs over the gRPC API (mutual TLS); see
// lib/velociraptorApi.ts for the reused runVQL transport seam.
//
// Distinct from Client Monitoring: that config type manages which EVENT
// ARTIFACTS run for clients already carrying a label; this one manages label
// MEMBERSHIP itself — which clients carry the label in the first place.
//
// Scale: unlike a fleet-wide label sweep, membership here is an explicit,
// operator-authored client-id list (bounded, like a static security group), not
// "every client matching some rule" — see README Coverage for why a dynamic,
// fleet-scanning label assignment is out of scope for a canvas config type.
//
// >>> VERIFY AGAINST A LIVE VELOCIRAPTOR SERVER <<<
// The label VQL is the single swap point for this config type and lives
// entirely in THIS file:
//   - labelSetVQL() / labelRemoveVQL()   label(client_id=, labels=[...], op=)
//   - CLIENTS_BY_LABEL_VQL()             clients(search='label:<label>')
// `label()` and `clients()` are real Velociraptor server functions
// (vql/server/labels.go, vql/server/clients/clients.go); the exact `client_id`
// column name returned by `clients()` is read defensively.

import type { ComponentRef, ConnectivityRef, CredentialRef } from '@veltrixsecops/app-sdk'
import {
  createVelociraptorClient,
  resolveApiClientConfig,
  vqlQuote,
  vqlStringArray,
  type VelociraptorClient,
  type VqlRow,
} from '../../lib/velociraptorApi'

// --- VQL (single swap point — VERIFY every function name below) ----------------

/**
 * Add or remove one client's label.
 * VERIFY: `label(client_id=<id>, labels=[<label>], op='set'|'remove')` — `set`
 * applies the label(s), `remove` clears them; `check` (unused here) tests
 * membership.
 */
export function labelSetVQL(clientId: string, label: string): string {
  return `SELECT label(client_id=${vqlQuote(clientId)}, labels=${vqlStringArray([label])}, op='set') AS result FROM scope()`
}

export function labelRemoveVQL(clientId: string, label: string): string {
  return `SELECT label(client_id=${vqlQuote(clientId)}, labels=${vqlStringArray([label])}, op='remove') AS result FROM scope()`
}

/**
 * List the client ids currently carrying a label.
 * VERIFY: `clients(search='label:<label>')` filters to clients holding that
 * label (the GUI's own search syntax); the returned `client_id` column name.
 */
export function clientsByLabelVQL(label: string): string {
  return `SELECT client_id FROM clients(search=${vqlQuote(`label:${label}`)})`
}

/** Pull the client_id column out of clients() rows, tolerant of casing. */
export function readClientIds(rows: VqlRow[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    const id = String(row['client_id'] ?? row['ClientId'] ?? row['clientId'] ?? '').trim()
    if (id && !seen.has(id)) {
      seen.add(id)
      out.push(id)
    }
  }
  return out
}

/** Set-difference: values in `a` that are not in `b`. */
export function diffIds(a: string[], b: string[]): string[] {
  const bSet = new Set(b)
  return a.filter((id) => !bSet.has(id))
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

/** Read the live client ids currently carrying `label` (empty on read failure). */
export async function liveClientIdsForLabel(
  client: VelociraptorClient,
  label: string,
  timeoutMs: number,
): Promise<string[]> {
  try {
    return readClientIds(await client.runVQL(clientsByLabelVQL(label), { timeoutMs }))
  } catch {
    return [] // best-effort: an unreadable fleet state is treated as "no known members"
  }
}

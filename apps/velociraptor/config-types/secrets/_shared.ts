// Shared helpers for the Velociraptor Secrets config type: named secret
// definitions (e.g. SMTP credentials, cloud API keys) artifacts can reference
// without exposing the raw value to every user, plus who is granted access. VQL
// runs over the gRPC API (mutual TLS); see lib/velociraptorApi.ts for the reused
// runVQL transport seam.
//
// SECURITY NOTE — the secret's raw payload is WRITE-ONLY, mirroring this app's
// existing Users & ACLs password field: it is sent to the server on every
// deploy and never read back. `secrets()` (the only read plugin) is documented
// to return metadata only (name/type/grantees), not the stored values — so drift
// detection and rollback can reconcile GRANTS but cannot detect or restore
// CONTENT changes. This is a structural limitation of the Velociraptor secrets
// API, not a shortcut — see README Coverage.
//
// >>> VERIFY AGAINST A LIVE VELOCIRAPTOR SERVER <<<
// The secrets VQL is the single swap point for this config type and lives
// entirely in THIS file:
//   - secretAddVQL()      secret_add(name=, type=, secret=<dict>)     — SERVER_ADMIN
//   - secretModifyVQL()   secret_modify(name=, type=, ...)            — SERVER_ADMIN
//   - SECRETS_VQL         secrets()                                   — SERVER_ADMIN
// (vql/server/secrets/{add,grant,list}.go). Whether `secret_add` upserts an
// existing secret's content or errors on a duplicate name is UNCERTAIN — flagged
// at the call site. The exact `secrets()` row shape (which columns hold the
// grantee users/orgs and the all-orgs-visible flag) is read defensively.

import type { ComponentRef, ConnectivityRef, CredentialRef } from '@veltrixsecops/app-sdk'
import {
  createVelociraptorClient,
  resolveApiClientConfig,
  vqlQuote,
  vqlStringArray,
  vqlJson,
  type VelociraptorClient,
  type VqlRow,
} from '../../lib/velociraptorApi'

// --- VQL (single swap point — VERIFY every function name below) ----------------

/** List every secret's metadata (not its content). VERIFY: plugin name `secrets`. */
export const SECRETS_VQL = 'SELECT * FROM secrets()'

/**
 * Create or overwrite a secret's content.
 * VERIFY: `secret_add(name=<name>, type=<type>, secret=<dict>)` — whether this
 * upserts an existing secret of the same name/type or errors on a duplicate is
 * UNCERTAIN; this app calls it on every deploy assuming upsert (same posture as
 * a re-sent password field).
 */
export function secretAddVQL(name: string, type: string, secret: Record<string, string>): string {
  return `SELECT secret_add(name=${vqlQuote(name)}, type=${vqlQuote(type)}, secret=${vqlJson(secret)}) AS name FROM scope()`
}

export interface SecretModifyOptions {
  addUsers?: string[]
  removeUsers?: string[]
  addOrgs?: string[]
  removeOrgs?: string[]
  visibleToAllOrgs?: boolean
  delete?: boolean
}

/**
 * Modify a secret's grants/visibility, or delete it outright.
 * VERIFY: `secret_modify(name=, type=, add_users=[...], remove_users=[...],
 * add_orgs=[...], remove_orgs=[...], visible_to_all_orgs=<bool>, delete=<bool>)`.
 * Boolean arguments are rendered as VQL's bare `TRUE`/`FALSE` literals (vfilter's
 * documented boolean grammar) — VERIFY against a live server.
 */
export function secretModifyVQL(name: string, type: string, opts: SecretModifyOptions): string {
  const parts = [`name=${vqlQuote(name)}`, `type=${vqlQuote(type)}`]
  if (opts.delete) parts.push('delete=TRUE')
  if (opts.addUsers?.length) parts.push(`add_users=${vqlStringArray(opts.addUsers)}`)
  if (opts.removeUsers?.length) parts.push(`remove_users=${vqlStringArray(opts.removeUsers)}`)
  if (opts.addOrgs?.length) parts.push(`add_orgs=${vqlStringArray(opts.addOrgs)}`)
  if (opts.removeOrgs?.length) parts.push(`remove_orgs=${vqlStringArray(opts.removeOrgs)}`)
  if (opts.visibleToAllOrgs !== undefined) parts.push(`visible_to_all_orgs=${opts.visibleToAllOrgs ? 'TRUE' : 'FALSE'}`)
  return `SELECT secret_modify(${parts.join(', ')}) AS result FROM scope()`
}

// --- reading --------------------------------------------------------------------

/** One secret's metadata as read from secrets(). VERIFY columns. */
export interface LiveSecret {
  name: string
  type: string
  /** Users granted access, when the server surfaces them (best-effort). */
  users: string[] | null
  /** Orgs granted access, when the server surfaces them (best-effort). */
  orgs: string[] | null
  /** Whether visible to all orgs, when the server surfaces it (best-effort). */
  visibleToAllOrgs: boolean | null
}

function stringArrayOrNull(value: unknown): string[] | null {
  if (Array.isArray(value)) return value.map((v) => String(v)).filter(Boolean)
  return null
}

/** Map secrets() rows into LiveSecret, tolerant of column naming/casing. */
export function readSecrets(rows: VqlRow[]): LiveSecret[] {
  return rows
    .map((row) => ({
      name: String(row['name'] ?? row['Name'] ?? '').trim(),
      type: String(row['type'] ?? row['Type'] ?? row['type_name'] ?? '').trim(),
      users: stringArrayOrNull(row['users'] ?? row['Users']),
      orgs: stringArrayOrNull(row['orgs'] ?? row['Orgs'] ?? row['org_ids']),
      visibleToAllOrgs:
        typeof row['visible_to_all_orgs'] === 'boolean'
          ? (row['visible_to_all_orgs'] as boolean)
          : typeof row['VisibleToAllOrgs'] === 'boolean'
            ? (row['VisibleToAllOrgs'] as boolean)
            : null,
    }))
    .filter((s) => s.name)
}

/** Find a live secret by exact (case-insensitive) name. */
export function findSecret(secrets: LiveSecret[], name: string): LiveSecret | null {
  const n = name.trim().toLowerCase()
  if (!n) return null
  return secrets.find((s) => s.name.toLowerCase() === n) ?? null
}

/**
 * Parse a "key: value" / "key=value" per-line secret payload into a dict, the
 * same hand-rolled, dependency-free approach lib/velociraptorApi.ts's
 * parseApiClientBundle uses for the api-client bundle. Blank lines and lines
 * without a separator are skipped.
 */
export function parseSecretPairs(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of String(raw ?? '').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const idx = trimmed.search(/[:=]/)
    if (idx === -1) continue
    const key = trimmed.slice(0, idx).trim()
    const value = trimmed.slice(idx + 1).trim()
    if (key) out[key] = value
  }
  return out
}

/** Set-difference: values in `a` that are not in `b` (case-sensitive). */
export function diffValues(a: string[], b: string[]): string[] {
  const bSet = new Set(b)
  return a.filter((v) => !bSet.has(v))
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

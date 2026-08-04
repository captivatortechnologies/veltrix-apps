// Shared helpers for the Velociraptor Users & ACLs config type (GUI users + their
// roles). VQL runs over the gRPC API (mutual TLS); see lib/velociraptorApi.ts for
// the reused runVQL transport seam.
//
// >>> VERIFY AGAINST A LIVE VELOCIRAPTOR SERVER <<<
// The user-management VQL is the single swap point for this config type and lives
// entirely in THIS file:
//   - GUI_USERS_VQL          reads the user list. VERIFY the returned columns:
//                            `name` is expected; whether `roles` is returned (and
//                            as an array vs CSV) is UNCERTAIN — readUsers() is
//                            tolerant and roles may be empty, which weakens role
//                            restore on rollback (flagged there).
//   - userCreateVQL()        create/update: user_create(user=, roles=[...], password=)
//   - userGrantVQL()         grant roles:   user_grant(user=, roles=[...])
//   - userGrantPolicyVQL()   grant/clear custom ACL permissions BEYOND named
//                            roles: user_grant(user=, policy={perm: true|false})
//   - userDeleteVQL()        delete:        user_delete(user=)
// user_create / user_grant / user_delete / gui_users are real Velociraptor server
// functions; reconcile the exact arguments + gui_users columns against a live
// server before production use.

import type { ComponentRef, ConnectivityRef, CredentialRef } from '@veltrixsecops/app-sdk'
import {
  createVelociraptorClient,
  resolveApiClientConfig,
  vqlQuote,
  vqlStringArray,
  vqlJson,
  splitList,
  type VelociraptorClient,
  type VqlRow,
} from '../../lib/velociraptorApi'

/** Well-known Velociraptor roles. Unknown roles are warned (not rejected) — the
 *  role set can vary by deployment. VERIFY against the target server's roles. */
export const KNOWN_ROLES = new Set([
  'reader',
  'analyst',
  'investigator',
  'administrator',
  'artifact_writer',
  'api',
  'org_admin',
])

/**
 * Well-known Velociraptor fine-grained ACL permissions (acls/acls.go's
 * ACL_PERMISSION constants) — the grant surface BEYOND named roles, applied via
 * user_grant(policy={...}) for access finer than the 7 roles above allow (e.g.
 * granting EXECVE without full administrator). Unknown permissions are warned
 * (not rejected), matching KNOWN_ROLES' posture.
 *
 * VERIFY: the exact wire/JSON casing user_grant's `policy` dict (and
 * gui_users()'s echo of it) expects — acls.go names these in UPPER_SNAKE
 * (`COLLECT_CLIENT`); this assumes the proto-JSON form is lower_snake
 * (`collect_client`), consistent with this app's other snake_case VQL args
 * (`client_id`, `org_id`). Unverified against a live server.
 */
export const KNOWN_PERMISSIONS = new Set([
  'any_query',
  'publish',
  'read_results',
  'label_client',
  'collect_client',
  'collect_basic',
  'start_hunt',
  'collect_server',
  'artifact_writer',
  'server_artifact_writer',
  'execve',
  'notebook_editor',
  'server_admin',
  'org_admin',
  'impersonation',
  'filesystem_read',
  'filesystem_write',
  'network',
  'machine_state',
  'prepare_results',
  'delete_results',
  'datastore_access',
])

/** Parse the CSV/newline custom-permissions field — same shape as parseRoles(). */
export const parsePermissions = parseRoles

// --- VQL (single swap point — VERIFY every function name + column below) --------

/**
 * List the GUI users.
 * VERIFY: `gui_users()` returns rows with a `name`; whether `roles` is included
 * (and its shape) is uncertain — readUsers() reads it defensively.
 */
export const GUI_USERS_VQL = 'SELECT * FROM gui_users()'

/**
 * Create or update a user with roles, optionally setting a password.
 * VERIFY: `user_create(user=<name>, roles=[...], password=<pw>)` — `roles` is a
 * list of strings; `password` is only for basic auth (omit under SSO).
 */
export function userCreateVQL(name: string, roles: string[], password?: string): string {
  const pw = password ? `, password=${vqlQuote(password)}` : ''
  return `SELECT user_create(user=${vqlQuote(name)}, roles=${vqlStringArray(roles)}${pw}) AS user FROM scope()`
}

/**
 * Grant a user a set of roles (used to restore prior roles on rollback).
 * VERIFY: `user_grant(user=<name>, roles=[...])`.
 */
export function userGrantVQL(name: string, roles: string[]): string {
  return `SELECT user_grant(user=${vqlQuote(name)}, roles=${vqlStringArray(roles)}) AS granted FROM scope()`
}

/**
 * Delete a user (used to undo a user this deploy created).
 * VERIFY: `user_delete(user=<name>)` removes the user.
 */
export function userDeleteVQL(name: string): string {
  return `SELECT user_delete(user=${vqlQuote(name)}) AS deleted FROM scope()`
}

/**
 * Grant/clear fine-grained ACL permissions beyond named roles (used both to
 * apply authored custom permissions on deploy and to restore/clear them on
 * rollback). VERIFY: `user_grant(user=<name>, policy=<dict>)` — a `true` value
 * grants a permission; whether `false` explicitly CLEARS it (vs. being ignored)
 * is UNCERTAIN — flagged at every call site that relies on it.
 */
export function userGrantPolicyVQL(name: string, policy: Record<string, boolean>): string {
  return `SELECT user_grant(user=${vqlQuote(name)}, policy=${vqlJson(policy)}) AS granted FROM scope()`
}

/**
 * Build the policy dict to send: `true` for every desired permission, and an
 * explicit `false` for every permission in `prior` that is no longer desired
 * (an attempt to CLEAR it — see userGrantPolicyVQL's VERIFY note). Returns an
 * empty object when there is nothing to change.
 */
export function buildPolicyDelta(desired: string[], prior: string[] | null): Record<string, boolean> {
  const policy: Record<string, boolean> = {}
  for (const permission of desired) policy[permission] = true
  for (const permission of prior ?? []) {
    if (!desired.includes(permission)) policy[permission] = false
  }
  return policy
}

// --- reading ------------------------------------------------------------------

/** A live GUI user as read from gui_users(). VERIFY columns. */
export interface LiveUser {
  name: string
  roles: string[]
  /** Fine-grained custom permissions, when the server surfaces them (best-
   *  effort) — null when the policy dict was absent/unreadable, distinct from
   *  an empty grant. */
  permissions: string[] | null
}

function rolesFromValue(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v)).filter(Boolean)
  if (typeof value === 'string') return splitList(value)
  return []
}

/** The permission names granted `true` in a gui_users() row's policy dict, or
 *  null when the dict is absent/not an object (distinct from "granted none"). */
function permissionsFromValue(value: unknown): string[] | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return Object.entries(value as Record<string, unknown>)
    .filter(([, granted]) => granted === true)
    .map(([permission]) => permission)
}

/** Map gui_users() rows into LiveUser, tolerant of the name/roles/policy column casing. */
export function readUsers(rows: VqlRow[]): LiveUser[] {
  return rows.map((row) => ({
    name: String(row['name'] ?? row['Name'] ?? '').trim(),
    roles: rolesFromValue(row['roles'] ?? row['Roles']),
    permissions: permissionsFromValue(row['policy'] ?? row['Policy']),
  })).filter((u) => u.name)
}

/** Find a live user by exact (case-insensitive) name. */
export function findUser(users: LiveUser[], name: string): LiveUser | null {
  const n = name.trim().toLowerCase()
  if (!n) return null
  return users.find((u) => u.name.toLowerCase() === n) ?? null
}

/** Parse the CSV/newline roles field into a clean role list. */
export function parseRoles(value: unknown): string[] {
  return splitList(value)
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

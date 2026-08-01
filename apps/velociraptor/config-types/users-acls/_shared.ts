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

// --- reading ------------------------------------------------------------------

/** A live GUI user as read from gui_users(). VERIFY columns. */
export interface LiveUser {
  name: string
  roles: string[]
}

function rolesFromValue(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v)).filter(Boolean)
  if (typeof value === 'string') return splitList(value)
  return []
}

/** Map gui_users() rows into LiveUser, tolerant of the name/roles column casing. */
export function readUsers(rows: VqlRow[]): LiveUser[] {
  return rows.map((row) => ({
    name: String(row['name'] ?? row['Name'] ?? '').trim(),
    roles: rolesFromValue(row['roles'] ?? row['Roles']),
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

// Shared helpers for the JumpCloud LDAP Server Settings config type
// (validate + deploy + rollback + healthCheck + driftDetect).
//
// Applied over the JumpCloud API v2 (/ldapservers/{id}). There is NO create or
// delete endpoint for LDAP servers (LDAP-as-a-Service instances are provisioned
// interactively in the JumpCloud Admin Console) — this config type only PATCHes
// settings on an EXISTING server.
//
// VERIFIED against JumpCloud's published API v2 OpenAPI spec
// (github.com/TheJumpCloud/jumpcloud-docs-public, docs/api/2.0/index.yaml):
//   LdapServerOutput (GET):  { id*, name, user_lockout_action, user_password_expiration_action }
//   LdapServerInput  (PATCH body): { name, user_lockout_action, user_password_expiration_action }
//   Both action fields accept "remove" | "disable".

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'

export const LDAP_ACTIONS = ['remove', 'disable'] as const
export type LdapAction = (typeof LDAP_ACTIONS)[number]

/** One JumpCloud LDAP server as returned by GET /ldapservers and GET /ldapservers/{id}. */
export interface JumpCloudLdapServer {
  id?: string
  name?: string
  user_lockout_action?: string
  user_password_expiration_action?: string
  [key: string]: unknown
}

/** The desired state for one LDAP server, extracted from a canvas item. */
export interface LdapServerSettingsSpec {
  /** Stable canvas item id — survives renames; used for rename-safe identity. */
  itemId?: string
  /** LDAP server name — the logical identity live servers are matched on. */
  name: string
  /** "" means "leave unmanaged" (omitted from the PATCH body). */
  userLockoutAction: string
  userPasswordExpirationAction: string
}

/** Each canvas item describes the settings of one existing JumpCloud LDAP server. */
export function extractLdapServerSettingsSpecs(canvas: CanvasSnapshot): LdapServerSettingsSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const fields = item.fields ?? {}
    return {
      itemId: item.id,
      name: String(fields.name ?? '').trim(),
      userLockoutAction: String(fields.userLockoutAction ?? '').trim(),
      userPasswordExpirationAction: String(fields.userPasswordExpirationAction ?? '').trim(),
    }
  })
}

/** Find a live LDAP server by name (case-insensitive — the stable identity). */
export function findLdapServerByName(servers: JumpCloudLdapServer[], name: string): JumpCloudLdapServer | null {
  const target = name.trim().toLowerCase()
  if (!target) return null
  return servers.find((s) => String(s.name ?? '').trim().toLowerCase() === target) ?? null
}

/**
 * Build the JumpCloud LdapServerInput PATCH body. `name` is always sent (it is
 * also how a rename is applied); the two action fields are only included when
 * the operator set them — an empty selection means "leave unmanaged", not
 * "clear it".
 */
export function buildLdapServerBody(spec: LdapServerSettingsSpec): Record<string, unknown> {
  const body: Record<string, unknown> = { name: spec.name }
  if (spec.userLockoutAction) body.user_lockout_action = spec.userLockoutAction
  if (spec.userPasswordExpirationAction) body.user_password_expiration_action = spec.userPasswordExpirationAction
  return body
}

/** The subset of a live server's fields this config type manages — captured for rollback. */
export function priorFieldsOf(server: JumpCloudLdapServer): Record<string, unknown> {
  const body: Record<string, unknown> = { name: String(server.name ?? '') }
  if (server.user_lockout_action) body.user_lockout_action = server.user_lockout_action
  if (server.user_password_expiration_action) body.user_password_expiration_action = server.user_password_expiration_action
  return body
}

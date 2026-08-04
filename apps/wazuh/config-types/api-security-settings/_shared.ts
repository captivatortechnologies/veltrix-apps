// Shared helpers for the Wazuh API-security-settings config type (validate +
// deploy + drift). This is a SINGLETON: the manager exposes exactly one
// `/security/config` resource (`auth_token_exp_timeout`, `rbac_mode`). The
// canvas `comment` field is audit-only and is never sent to the manager.
//
// Field shapes verified against the Wazuh API OpenAPI spec (api/api/spec/spec.yaml,
// tag v4.14.7, github.com/wazuh/wazuh) — GET/PUT/DELETE `/security/config`,
// `SecurityConfiguration` schema (`auth_token_exp_timeout: integer`,
// `rbac_mode: string`, documented values "white"/"black").

import type { CanvasItemSnapshot } from '@veltrixsecops/app-sdk'

export type RbacMode = 'white' | 'black'

export interface SecuritySettingsSpec {
  authTokenExpTimeout: number
  rbacMode: RbacMode
  comment: string
}

export interface SecuritySettingsBody {
  auth_token_exp_timeout: number
  rbac_mode: RbacMode
}

/** Parse a value as a non-negative integer; returns null when it isn't one. */
export function parseNonNegativeInt(value: unknown): number | null {
  const n = Number(value)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return null
  return n
}

export function specFromItem(item: CanvasItemSnapshot): SecuritySettingsSpec {
  const rbacModeRaw = String(item.fields.rbac_mode ?? 'white').trim().toLowerCase()
  return {
    authTokenExpTimeout: parseNonNegativeInt(item.fields.auth_token_exp_timeout) ?? -1,
    rbacMode: rbacModeRaw === 'black' ? 'black' : 'white',
    comment: String(item.fields.comment ?? '').trim(),
  }
}

export function toSecurityConfigBody(spec: SecuritySettingsSpec): SecuritySettingsBody {
  return { auth_token_exp_timeout: spec.authTokenExpTimeout, rbac_mode: spec.rbacMode }
}

export function securityConfigEquals(a: SecuritySettingsBody, b: SecuritySettingsBody): boolean {
  return a.auth_token_exp_timeout === b.auth_token_exp_timeout && a.rbac_mode === b.rbac_mode
}

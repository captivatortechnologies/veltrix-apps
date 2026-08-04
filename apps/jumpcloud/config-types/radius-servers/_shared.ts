// Shared helpers for the JumpCloud RADIUS Servers config type
// (validate + deploy + rollback + healthCheck + driftDetect).
//
// RADIUS servers are applied over the JumpCloud API v1 (/radiusservers) —
// VERIFIED against JumpCloud's published API v1 OpenAPI spec
// (github.com/TheJumpCloud/jumpcloud-docs-public, docs/api/1.0/index.yaml). The
// v2 RADIUS Servers API only exposes association endpoints (no create/update/
// delete on the server object), so this config type uses v1 for the server
// definition itself.
//
// FLAGGED — an API inconsistency, not a guess: the v1 POST body field for tags
// is documented as `tagNames`; the v1 PUT body field is documented as `tags`.
// This config type sends the operator's declared tag list under whichever name
// each operation's own schema documents.

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'

export const RADIUS_MFA_VALUES = ['DISABLED', 'ENABLED', 'REQUIRED', 'ALWAYS'] as const
export const RADIUS_AUTH_IDP_VALUES = ['JUMPCLOUD', 'AZURE'] as const
export const RADIUS_CA_SOURCE_VALUES = ['NONE', 'BYOC', 'JUMPCLOUD_MANAGED'] as const

/** One JumpCloud RADIUS server as returned by GET /radiusservers and GET /radiusservers/{id}. */
export interface JumpCloudRadiusServer {
  _id?: string
  name?: string
  networkSourceIp?: string
  sharedSecret?: string
  authIdp?: string
  mfa?: string
  userLockoutAction?: string
  userPasswordExpirationAction?: string
  userPasswordEnabled?: boolean
  userCertEnabled?: boolean
  deviceCertEnabled?: boolean
  caCert?: string
  requireTlsAuth?: boolean
  radsecEnabled?: boolean
  requireRadsec?: boolean
  caSource?: string
  tagNames?: string[]
  tags?: string[]
  [key: string]: unknown
}

/** The desired state for one RADIUS server, extracted from a canvas item. */
export interface RadiusServerSpec {
  itemId?: string
  name: string
  networkSourceIp: string
  sharedSecret: string
  authIdp: string
  mfa: string
  userLockoutAction: string
  userPasswordExpirationAction: string
  userPasswordEnabled: boolean
  userCertEnabled: boolean
  deviceCertEnabled: boolean
  caCert: string
  requireTlsAuth: boolean
  radsecEnabled: boolean
  requireRadsec: boolean
  caSource: string
  tags: string[]
}

/** Coerce a checkbox-ish value to a boolean, with a caller-supplied default. */
export function normalizeBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  const s = String(value ?? '').trim().toLowerCase()
  if (s === 'true' || s === '1' || s === 'yes') return true
  if (s === 'false' || s === '0' || s === 'no') return false
  return fallback
}

/** Split a tags value (a tags array or a newline/comma string) into trimmed entries. */
export function toTagList(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : String(value ?? '').split(/[\n,]/)
  const seen = new Set<string>()
  const out: string[] = []
  for (const entry of raw) {
    const s = String(entry ?? '').trim()
    if (!s) continue
    const key = s.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(s)
  }
  return out
}

/** Each canvas item describes one JumpCloud RADIUS server. */
export function extractRadiusServerSpecs(canvas: CanvasSnapshot): RadiusServerSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const fields = item.fields ?? {}
    return {
      itemId: item.id,
      name: String(fields.name ?? '').trim(),
      networkSourceIp: String(fields.networkSourceIp ?? '').trim(),
      sharedSecret: String(fields.sharedSecret ?? ''),
      authIdp: String(fields.authIdp ?? 'JUMPCLOUD').trim() || 'JUMPCLOUD',
      mfa: String(fields.mfa ?? 'DISABLED').trim() || 'DISABLED',
      userLockoutAction: String(fields.userLockoutAction ?? '').trim(),
      userPasswordExpirationAction: String(fields.userPasswordExpirationAction ?? '').trim(),
      userPasswordEnabled: normalizeBool(fields.userPasswordEnabled, true),
      userCertEnabled: normalizeBool(fields.userCertEnabled, false),
      deviceCertEnabled: normalizeBool(fields.deviceCertEnabled, false),
      caCert: String(fields.caCert ?? '').trim(),
      requireTlsAuth: normalizeBool(fields.requireTlsAuth, false),
      radsecEnabled: normalizeBool(fields.radsecEnabled, false),
      requireRadsec: normalizeBool(fields.requireRadsec, false),
      caSource: String(fields.caSource ?? 'NONE').trim() || 'NONE',
      tags: toTagList(fields.tags),
    }
  })
}

/** Find a live RADIUS server by name (case-insensitive — the stable identity). */
export function findRadiusServerByName(servers: JumpCloudRadiusServer[], name: string): JumpCloudRadiusServer | null {
  const target = name.trim().toLowerCase()
  if (!target) return null
  return servers.find((s) => String(s.name ?? '').trim().toLowerCase() === target) ?? null
}

/** Fields common to both create and update bodies. */
function commonFields(spec: RadiusServerSpec): Record<string, unknown> {
  return {
    name: spec.name,
    networkSourceIp: spec.networkSourceIp,
    sharedSecret: spec.sharedSecret,
    mfa: spec.mfa,
    userLockoutAction: spec.userLockoutAction,
    userPasswordExpirationAction: spec.userPasswordExpirationAction,
    userPasswordEnabled: spec.userPasswordEnabled,
    userCertEnabled: spec.userCertEnabled,
    deviceCertEnabled: spec.deviceCertEnabled,
    caCert: spec.caCert,
    requireTlsAuth: spec.requireTlsAuth,
    radsecEnabled: spec.radsecEnabled,
    requireRadsec: spec.requireRadsec,
    caSource: spec.caSource,
  }
}

/** Build the JumpCloud RadiusServerPost body for POST /radiusservers. Includes `authIdp` (create-only) and `tagNames`. */
export function buildRadiusServerCreateBody(spec: RadiusServerSpec): Record<string, unknown> {
  return { ...commonFields(spec), authIdp: spec.authIdp, tagNames: spec.tags }
}

/** Build the JumpCloud RadiusServerPut body for PUT /radiusservers/{id}. Includes `tags` (not `tagNames`, and no `authIdp` — unsupported on update per the API's own model). */
export function buildRadiusServerUpdateBody(spec: RadiusServerSpec): Record<string, unknown> {
  return { ...commonFields(spec), tags: spec.tags }
}

/**
 * The subset of a live server's fields this config type manages — captured for
 * rollback. Because JumpCloud's GET response includes `sharedSecret`, the true
 * prior secret is captured (not a placeholder), so rollback can restore it exactly.
 */
export function priorFieldsOf(server: JumpCloudRadiusServer): Record<string, unknown> {
  return {
    name: String(server.name ?? ''),
    networkSourceIp: String(server.networkSourceIp ?? ''),
    sharedSecret: String(server.sharedSecret ?? ''),
    mfa: String(server.mfa ?? 'DISABLED'),
    userLockoutAction: String(server.userLockoutAction ?? ''),
    userPasswordExpirationAction: String(server.userPasswordExpirationAction ?? ''),
    userPasswordEnabled: Boolean(server.userPasswordEnabled),
    userCertEnabled: Boolean(server.userCertEnabled),
    deviceCertEnabled: Boolean(server.deviceCertEnabled),
    caCert: String(server.caCert ?? ''),
    requireTlsAuth: Boolean(server.requireTlsAuth),
    radsecEnabled: Boolean(server.radsecEnabled),
    requireRadsec: Boolean(server.requireRadsec),
    caSource: String(server.caSource ?? 'NONE'),
    tags: Array.isArray(server.tags) ? server.tags : Array.isArray(server.tagNames) ? server.tagNames : [],
  }
}

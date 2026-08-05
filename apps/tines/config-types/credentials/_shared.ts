// Shared helpers for the Tines Credentials config type
// (validate + deploy + rollback + drift + health).
//
// A Tines Credential lives at /api/v1/user_credentials and is keyed for
// reconciliation by (team_id, name). Secret material is WRITE-ONLY — Tines
// never echoes it back, so `secret_value` (TEXT mode) and `secret_config`
// (AWS/JWT/OAUTH/MTLS modes, flat key/value) are sent only when non-blank,
// never captured into rollbackData, and never drift-checked. Same trade-off
// as apps/cribl's Secrets type and apps/splunk-soar's Assets `configuration`.
//
// Docs (fetched 2026-08-05): https://www.tines.com/api/credentials
//   list:   GET    /api/v1/user_credentials?team_id=  -> { user_credentials: [...], meta }
//   create: POST   /api/v1/user_credentials  <- { name, mode, team_id, value?/aws_*?/..., folder_id?,
//                     read_access?, shared_team_slugs?, description?, metadata?, allowed_hosts?,
//                     expires_at?, expiry_notifications_enabled? }
//   update: PUT    /api/v1/user_credentials/{id}  <- same fields, all optional
//   delete: DELETE /api/v1/user_credentials/{id}
//
// HTTP_REQUEST_AGENT and MULTI_REQUEST modes are intentionally excluded — see
// the README Coverage section (their bodies are nested/array-shaped, not the
// flat secret material this config type models).

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'

export const CREDENTIAL_MODES = ['TEXT', 'AWS', 'JWT', 'OAUTH', 'MTLS'] as const
export type CredentialMode = (typeof CREDENTIAL_MODES)[number]
export const READ_ACCESS_VALUES = ['TEAM', 'GLOBAL', 'SPECIFIC_TEAMS'] as const

/** A Credential as returned by the Tines Credentials API — metadata only, never the secret. */
export interface LiveCredential {
  id?: number | string
  name?: string
  mode?: string
  team_id?: number | string
  folder_id?: number | string | null
  read_access?: string
  shared_team_slugs?: string[]
  description?: string
  metadata?: Record<string, string>
  allowed_hosts?: string[]
  expires_at?: string | null
  expiry_notifications_enabled?: boolean
}

/** One canvas item, normalized to the fields this config type manages. */
export interface CredentialSpec {
  itemName: string
  name: string
  teamId: string
  mode: string
  folderName: string
  secretValue: string
  secretConfig: Record<string, string>
  description: string
  metadata: Record<string, string>
  allowedHosts: string[]
  expiresAt: string
  expiryNotificationsEnabled: boolean
  readAccess: string
  sharedTeamSlugs: string[]
}

function coerceScalar(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value == null) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return ''
  }
}

/** Read a `keyvalue` canvas field, accepting either its array-of-pairs or object-map runtime shape. */
export function readKeyValueMap(value: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item && typeof item === 'object') {
        const rec = item as Record<string, unknown>
        const key = String(rec.key ?? rec.name ?? '').trim()
        if (key) out[key] = coerceScalar(rec.value)
      }
    }
    return out
  }
  if (value && typeof value === 'object') {
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      const k = key.trim()
      if (k) out[k] = coerceScalar(v)
    }
  }
  return out
}

export function extractCredentialSpecs(canvas: CanvasSnapshot): CredentialSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const fields = item.fields ?? {}
    const hostsRaw = fields.allowed_hosts
    const slugsRaw = fields.shared_team_slugs
    return {
      itemName: item.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      teamId: typeof fields.team_id === 'string' ? fields.team_id.trim() : String(fields.team_id ?? '').trim(),
      mode: typeof fields.mode === 'string' ? fields.mode.trim() : '',
      folderName: typeof fields.folder_name === 'string' ? fields.folder_name.trim() : '',
      secretValue: typeof fields.secret_value === 'string' ? fields.secret_value : '',
      secretConfig: readKeyValueMap(fields.secret_config),
      description: typeof fields.description === 'string' ? fields.description.trim() : '',
      metadata: readKeyValueMap(fields.metadata),
      allowedHosts: Array.isArray(hostsRaw) ? hostsRaw.map((h) => String(h).trim()).filter(Boolean) : [],
      expiresAt: typeof fields.expires_at === 'string' ? fields.expires_at.trim() : '',
      expiryNotificationsEnabled: fields.expiry_notifications_enabled === true,
      readAccess: typeof fields.read_access === 'string' && fields.read_access ? fields.read_access : 'TEAM',
      sharedTeamSlugs: Array.isArray(slugsRaw) ? slugsRaw.map((s) => String(s).trim()).filter(Boolean) : [],
    }
  })
}

/**
 * Build the request body for POST/PUT /user_credentials. Secret fields
 * (`value` for TEXT, or the mode-specific flat keys for AWS/JWT/OAUTH/MTLS)
 * are included ONLY when the operator supplied them — required on create,
 * optional on update (blank keeps the existing secret unchanged, per Tines).
 */
export function buildCredentialBody(spec: CredentialSpec, folderId: string | null): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: spec.name,
    mode: spec.mode,
    team_id: spec.teamId,
    read_access: spec.readAccess,
  }
  if (folderId) body.folder_id = folderId
  if (spec.description) body.description = spec.description
  if (Object.keys(spec.metadata).length > 0) body.metadata = spec.metadata
  if (spec.allowedHosts.length > 0) body.allowed_hosts = spec.allowedHosts
  if (spec.expiresAt) body.expires_at = spec.expiresAt
  if (spec.expiryNotificationsEnabled) body.expiry_notifications_enabled = true
  if (spec.readAccess === 'SPECIFIC_TEAMS' && spec.sharedTeamSlugs.length > 0) {
    body.shared_team_slugs = spec.sharedTeamSlugs
  }

  if (spec.mode === 'TEXT') {
    if (spec.secretValue) body.value = spec.secretValue
  } else {
    Object.assign(body, spec.secretConfig)
  }

  return body
}

/** Find a live credential by (team, name) — the reconciliation identity. */
export function findCredential(credentials: LiveCredential[], teamId: string, name: string): LiveCredential | null {
  const n = name.trim().toLowerCase()
  if (!n) return null
  return (
    credentials.find((c) => String(c.team_id ?? '') === teamId && String(c.name ?? '').trim().toLowerCase() === n) ?? null
  )
}

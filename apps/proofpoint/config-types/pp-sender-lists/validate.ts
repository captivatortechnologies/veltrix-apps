import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { asObject, ppErrorMessage, type PPClient } from '../../lib/proofpoint'

// --- Proofpoint Essentials sender-list constraints ---------------------------
//
// Safe (allow) and Blocked (deny) sender entries can be managed at three scopes,
// each its own dedicated sub-resource on the Essentials Interface API — read via
// GET, changed via POST (add)/PATCH (replace the declared list wholesale)/DELETE:
//   org    /orgs/{org}/sender-lists
//   user   /orgs/{org}/users/{email}/sender-lists
//   group  /orgs/{org}/groups/{groupId}/sender-lists
// All three return/accept the same shape: { allow_list: string[], block_list: string[] }.
// A user or group scope requires that user/group to already exist in Essentials
// (this app does not create them — see the README's User-provisioning scope note).
//
// NOTE ON A PRIOR VERSION OF THIS FILE: earlier releases reconciled the org scope
// by reading/writing `allow_list`/`block_list` directly on the *organization*
// object (GET/PUT /orgs/{org}). Re-verified against the live Essentials Interface
// API OpenAPI document (https://{stack}.proofpointessentials.com/apidocs/apidocs/docs,
// re-checked 2026-08-04): the Organization resource's actual sender-list fields
// are named `safe_list_senders` / `block_list_senders` (not `allow_list` /
// `block_list`), and /orgs/{org} no longer documents a PUT method at all (only
// GET/DELETE/PATCH). `allow_list`/`block_list` belong to the dedicated
// `/orgs/{org}/sender-lists` resource (and its user/group siblings) used below —
// this was a wire-mapping bug (wrong endpoint + wrong field names for the org
// scope). Fixed here; see CHANGELOG.
export const SAFE_FIELD = 'allow_list'
export const BLOCKED_FIELD = 'block_list'

export const LIST_TYPES = ['safe', 'blocked'] as const
export type ListType = (typeof LIST_TYPES)[number]

export const SCOPE_TYPES = ['org', 'user', 'group'] as const
export type ScopeType = (typeof SCOPE_TYPES)[number]

// Loose entry check: an email, a domain (optionally *@), or an IP / CIDR.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const DOMAIN_RE = /^(?:\*@)?(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i
const IP_CIDR_RE = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d|\*)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d|\*)(?:\/\d{1,2})?$/

export interface SenderSpec {
  sectionName: string
  sender: string
  listType: string
  scope: string
  scopeId: string
}

/** The sender value (lower-cased) — a sender entry's identity within a scope. */
export function senderKey(sender: string): string {
  return sender.trim().toLowerCase()
}

/**
 * A scope's identity: `org`, `user:<email>` or `group:<id>` (lower-cased). Two
 * entries with the same sender in *different* scopes are independent — this key
 * (not the bare sender) is a scoped entry's true natural key.
 */
export function scopeKey(scope: string, scopeId: string): string {
  const normalizedScope = SCOPE_TYPES.includes(scope as ScopeType) ? scope : 'org'
  const id = scopeId.trim().toLowerCase()
  return normalizedScope === 'org' ? 'org' : `${normalizedScope}:${id}`
}

/** Each canvas item describes one scoped sender-list entry. */
export function extractSenderSpecs(canvas: CanvasSnapshot): SenderSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      sender: typeof fields.sender === 'string' ? fields.sender.trim() : '',
      listType: typeof fields.list_type === 'string' && fields.list_type.trim() ? fields.list_type.trim() : 'safe',
      scope: typeof fields.scope === 'string' && fields.scope.trim() ? fields.scope.trim() : 'org',
      scopeId: typeof fields.scope_id === 'string' ? fields.scope_id.trim() : '',
    }
  })
}

export function isValidEntry(value: string): boolean {
  return EMAIL_RE.test(value) || DOMAIN_RE.test(value) || IP_CIDR_RE.test(value)
}

// --- Scoped sender-list I/O (shared by deploy / rollback / healthCheck / drift) -

/** Build the `/sender-lists` path for a scope (org, user or group). */
export function senderListsPath(client: PPClient, scope: string, scopeId: string): string {
  if (scope === 'user') return `${client.orgPath}/users/${encodeURIComponent(scopeId)}/sender-lists`
  if (scope === 'group') return `${client.orgPath}/groups/${encodeURIComponent(scopeId)}/sender-lists`
  return `${client.orgPath}/sender-lists`
}

/** A human-readable label for a scope, for messages/diff field names. */
export function scopeLabel(scope: string, scopeId: string): string {
  if (scope === 'user') return `user "${scopeId}"`
  if (scope === 'group') return `group "${scopeId}"`
  return 'organization'
}

/** Read the `{ allow_list, block_list }` sender-lists resource for a scope. */
export async function getSenderLists(client: PPClient, scope: string, scopeId: string): Promise<Record<string, unknown>> {
  const res = await client.request('GET', senderListsPath(client, scope, scopeId))
  if (!res.ok) throw new Error(`Failed to read ${scopeLabel(scope, scopeId)} sender lists: ${ppErrorMessage(res)}`)
  return asObject(res.body, 'sender-lists', 'sender_lists')
}

/** Read one sender list (safe/blocked) off a `{ allow_list, block_list }` record. */
export function readSenderList(list: Record<string, unknown>, listType: string): string[] {
  const field = listType === 'blocked' ? BLOCKED_FIELD : SAFE_FIELD
  const value = list[field]
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter((v) => v.length > 0)
  return []
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate sender-list configurations: the sender value is required and must look
 * like an email, domain or IP/CIDR (warned, not failed, when it doesn't); the list
 * type must be "safe" or "blocked"; the scope must be "org" (default), "user" or
 * "group"; a user/group scope requires a scope_id (and a user scope_id should look
 * like an email); and each (scope, scope_id, sender) tuple may be declared only
 * once across the canvas.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractSenderSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.sender) {
      errors.push({ field: `${prefix}.sender`, message: 'Sender is required', code: 'required' })
    } else if (!isValidEntry(spec.sender)) {
      warnings.push({
        field: `${prefix}.sender`,
        message: `"${spec.sender}" is not an email address, domain or IP/CIDR — Proofpoint may reject it`,
        code: 'sender_format',
      })
    }

    if (!LIST_TYPES.includes(spec.listType as ListType)) {
      errors.push({ field: `${prefix}.list_type`, message: `Unsupported list "${spec.listType}" — use "safe" or "blocked"`, code: 'invalid_list' })
    }

    if (!SCOPE_TYPES.includes(spec.scope as ScopeType)) {
      errors.push({
        field: `${prefix}.scope`,
        message: `Unsupported scope "${spec.scope}" — use "org", "user" or "group"`,
        code: 'invalid_scope',
      })
    } else if (spec.scope !== 'org' && !spec.scopeId) {
      errors.push({
        field: `${prefix}.scope_id`,
        message: `A ${spec.scope} scope requires a Scope target (the ${spec.scope === 'user' ? "user's email address" : 'group name/id'})`,
        code: 'scope_id_required',
      })
    } else if (spec.scope === 'user' && spec.scopeId && !EMAIL_RE.test(spec.scopeId)) {
      warnings.push({
        field: `${prefix}.scope_id`,
        message: `"${spec.scopeId}" is not an email address — a user scope target should be the user's primary email`,
        code: 'scope_id_format',
      })
    }

    if (spec.sender) {
      const key = `${scopeKey(spec.scope, spec.scopeId)}:${senderKey(spec.sender)}`
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.sender`,
          message: `Duplicate sender "${spec.sender}" in ${scopeLabel(spec.scope, spec.scopeId)} — a sender may only be declared once per scope (in one list)`,
          code: 'duplicate_sender',
        })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}

import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { asArray, ppErrorMessage, type PPClient } from '../../lib/proofpoint'

// --- Proofpoint Essentials sender-list constraints ---------------------------
//
// The organization keeps a Safe Sender list and a Blocked Sender list. They are
// attributes of the org object (/orgs/{org}) — read via GET, updated via PUT
// (Organization features are read via GET and updated via PUT). Each entry is a
// full email address (name@domain.com), a domain (domain.com or *@domain.com) or
// an IP address (full, wildcard, or CIDR). See help.proofpoint.com Essentials
// "Sender List Information via API" / "Setting up sender lists".
//
// The org fields that carry the two lists. Centralized here so the wire mapping is
// a single point of change.
export const SAFE_FIELD = 'allow_list'
export const BLOCKED_FIELD = 'block_list'

export const LIST_TYPES = ['safe', 'blocked'] as const
export type ListType = (typeof LIST_TYPES)[number]

// Loose entry check: an email, a domain (optionally *@), or an IP / CIDR.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const DOMAIN_RE = /^(?:\*@)?(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i
const IP_CIDR_RE = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d|\*)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d|\*)(?:\/\d{1,2})?$/

export interface SenderSpec {
  sectionName: string
  sender: string
  listType: string
}

/** The sender value (lower-cased) — a sender entry's identity across the org lists. */
export function senderKey(sender: string): string {
  return sender.trim().toLowerCase()
}

/** Each canvas item describes one sender-list entry. */
export function extractSenderSpecs(canvas: CanvasSnapshot): SenderSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      sender: typeof fields.sender === 'string' ? fields.sender.trim() : '',
      listType: typeof fields.list_type === 'string' && fields.list_type.trim() ? fields.list_type.trim() : 'safe',
    }
  })
}

export function isValidEntry(value: string): boolean {
  return EMAIL_RE.test(value) || DOMAIN_RE.test(value) || IP_CIDR_RE.test(value)
}

// --- Org sender-list I/O (shared by deploy / rollback / healthCheck / drift) ---

/** Read the org object; throws on a non-OK response. Returns the raw org record. */
export async function getOrg(client: PPClient): Promise<Record<string, unknown>> {
  const res = await client.request('GET', client.orgPath)
  if (!res.ok) throw new Error(`Failed to read organization: ${ppErrorMessage(res)}`)
  const parsed = JSON.parse(res.body || '{}')
  // Some deployments wrap the org in { data: {...} }.
  if (parsed && typeof parsed === 'object' && parsed.data && typeof parsed.data === 'object') {
    return parsed.data as Record<string, unknown>
  }
  return (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>
}

/** Read one sender list (safe/blocked) off an org record as a normalized array. */
export function readSenderList(org: Record<string, unknown>, listType: string): string[] {
  const field = listType === 'blocked' ? BLOCKED_FIELD : SAFE_FIELD
  const value = org[field]
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter((v) => v.length > 0)
  // Tolerate a stringified body being handed in.
  if (typeof value === 'string') return asArray<string>(value).map((v) => String(v).trim()).filter(Boolean)
  return []
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate sender-list configurations: the sender value is required and must look
 * like an email, domain or IP/CIDR (warned, not failed, when it doesn't); the list
 * type must be "safe" or "blocked"; and each sender value (natural key) may be
 * declared only once across the canvas.
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

    if (spec.sender) {
      const key = senderKey(spec.sender)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.sender`,
          message: `Duplicate sender "${spec.sender}" — a sender may only be declared once (in one list)`,
          code: 'duplicate_sender',
        })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}

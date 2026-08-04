import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { asObject, ppErrorMessage, type PPClient } from '../../lib/proofpoint'

// --- Proofpoint Essentials email-tagging exemption constraints ---------------
//
// The exempt-sender list is a dedicated sub-resource of the organization:
//   GET/POST/DELETE /orgs/{org}/email-tagging/exemptions   { exemptions: string[] }
// GET/POST are unambiguous (read the list; "Create Email Tagging Exempt Senders"
// adds the given senders). DELETE's request body is not fully documented in the
// live OpenAPI spec (https://{stack}.proofpointessentials.com/apidocs/apidocs/docs,
// tag "email tagging") beyond its summary, "Delete *specified* Email Tagging
// Exempt Senders" — the word "specified" indicates the caller supplies which
// senders to remove (the same `{ exemptions: [...] }` shape as GET/POST), not a
// bulk "delete everything". rollback.ts relies on that reading; re-verify
// against a live tenant if rollback appears to remove more than it added.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export interface ExemptionSpec {
  sectionName: string
  sender: string
}

/** The sender value (lower-cased) — an exemption's identity. */
export function senderKey(sender: string): string {
  return sender.trim().toLowerCase()
}

/** Each canvas item describes one exempt sender. */
export function extractExemptionSpecs(canvas: CanvasSnapshot): ExemptionSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return { sectionName: section.name, sender: typeof fields.sender === 'string' ? fields.sender.trim() : '' }
  })
}

// --- Exemption list I/O (shared by deploy / rollback / healthCheck / drift) ---

/** Read the org's current email-tagging exemption list; throws on a non-OK response. */
export async function getExemptions(client: PPClient): Promise<string[]> {
  const res = await client.request('GET', `${client.orgPath}/email-tagging/exemptions`)
  if (!res.ok) throw new Error(`Failed to read email-tagging exemptions: ${ppErrorMessage(res)}`)
  const body = asObject(res.body)
  const value = body.exemptions
  return Array.isArray(value) ? value.map((v) => String(v).trim()).filter((v) => v.length > 0) : []
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate email-tagging exemptions: the sender is required and should look
 * like an email address (warned, not failed — Essentials may accept a domain
 * too), and each sender (natural key) may be declared only once across the
 * canvas.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractExemptionSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.sender) {
      errors.push({ field: `${prefix}.sender`, message: 'Sender email is required', code: 'required' })
    } else if (!EMAIL_RE.test(spec.sender)) {
      warnings.push({ field: `${prefix}.sender`, message: `"${spec.sender}" does not look like an email address`, code: 'sender_format' })
    }

    if (spec.sender) {
      const key = senderKey(spec.sender)
      if (seen.has(key)) {
        errors.push({ field: `${prefix}.sender`, message: `Duplicate exempt sender "${spec.sender}" — each sender may only be declared once`, code: 'duplicate_sender' })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}

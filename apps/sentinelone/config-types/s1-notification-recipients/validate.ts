import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- SentinelOne notification recipient constraints ---------------------------
// Source: SentinelOne Management API v2.1 `/settings/recipients` — the emails
// (and SMS numbers) configured to receive SentinelOne alert notifications.
// Source: Celerium/SentinelOne-PowerShellWrapper
// `Get-SentinelOneSettingEmailRecipients` (GET /settings/recipients; fields
// email/name/sms; scoped by accountIds/siteIds only — no groupIds, so this
// config type is not offered at the "group" scope). See
// config-types/s1-notification-recipients/deploy.ts for the full citation.

/** Message shown when the app is configured at an unsupported "group" scope. */
export const RECIPIENTS_UNSUPPORTED_SCOPE_MESSAGE =
  'SentinelOne notification recipients are configured at the account/site/global scope — set the Scope setting to account, site or global (not group).'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface RecipientSpec {
  sectionName: string
  email: string
  name?: string
  sms?: string
}

/** Shape of a recipient returned by GET /settings/recipients. */
export interface LiveRecipient {
  id?: string
  email?: string
  name?: string
  sms?: string
}

/** The recipient's logical identity at a scope: its email, case-insensitive and trimmed. */
export function recipientKey(email: string): string {
  return email.trim().toLowerCase()
}

/** Each canvas item describes one SentinelOne notification recipient. */
export function extractRecipientSpecs(canvas: CanvasSnapshot): RecipientSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
    const optStr = (value: unknown): string | undefined => str(value) || undefined
    return {
      sectionName: section.name,
      email: str(fields.email),
      name: optStr(fields.name),
      sms: optStr(fields.sms),
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate notification recipient configurations: an email is required and
 * must look like an email address, and each email (case-insensitive) must be
 * unique across the canvas. The "group" scope is rejected — recipients are
 * account/site/global only.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  if (typeof ctx.settings?.scope === 'string' && ctx.settings.scope.trim().toLowerCase() === 'group') {
    errors.push({ field: 'scope', message: RECIPIENTS_UNSUPPORTED_SCOPE_MESSAGE, code: 'unsupported_scope' })
  }

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractRecipientSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.email) {
      errors.push({ field: `${prefix}.email`, message: 'Email is required', code: 'required' })
    } else if (!EMAIL_RE.test(spec.email)) {
      errors.push({ field: `${prefix}.email`, message: `"${spec.email}" does not look like an email address`, code: 'invalid_email' })
    }

    if (spec.email) {
      const key = recipientKey(spec.email)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.email`,
          message: `Duplicate recipient "${spec.email}" — each email may only be declared once`,
          code: 'duplicate_recipient',
        })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}

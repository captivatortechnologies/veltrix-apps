import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { parseJsonObject } from '../../lib/cyberark'

// =============================================================================
// CyberArk Accounts — validate + shared spec extraction.
//
// An account is a privileged credential stored in a safe. CyberArk assigns an
// `id`, but the logical identity for reconciliation is the (name, safe) pair.
//
// ⚠ WRITE-ONLY SECRET. Each item may carry a `secret` (the password / SSH key).
// CyberArk NEVER returns the secret on read. This app therefore sends the secret
// ONLY when CREATING an account; it is never read back, diffed, or stored in
// rollbackData / artifacts / logs, and existing accounts' secrets are left
// untouched (rotate them through CyberArk's own change-password workflow). This
// module only checks for the secret's PRESENCE — it never inspects its value.
// =============================================================================

/** A CyberArk secret is a password or an SSH key. */
export const SECRET_TYPES = ['password', 'key'] as const
export type SecretType = (typeof SECRET_TYPES)[number]

export interface AccountSpec {
  sectionName: string
  name: string
  safeName: string
  platformId: string
  address: string
  userName: string
  secretType: SecretType
  /** ⚠ Write-only. Sent only on create; never read/diffed/stored. */
  secret: string
  /** Raw platform-account-properties JSON (parsed at deploy). */
  platformPropertiesJson: string
  automaticManagementEnabled: boolean
  manualManagementReason: string
}

/** Shape of an account returned by GET /Accounts (never carries the secret). */
export interface LiveAccount {
  id?: string
  name?: string
  safeName?: string
  platformId?: string
  address?: string
  userName?: string
  secretManagement?: { automaticManagementEnabled?: boolean; manualManagementReason?: string }
  platformAccountProperties?: Record<string, unknown>
}

/** The (name, safeName) natural key — an account's logical identity. */
export function accountKey(spec: { name: string; safeName: string }): string {
  return JSON.stringify([spec.name.trim().toLowerCase(), spec.safeName.trim().toLowerCase()])
}

function readBool(value: unknown, fallback: boolean): boolean {
  if (value === true || value === 'true') return true
  if (value === false || value === 'false') return false
  return fallback
}

/** Each canvas item describes one CyberArk account. */
export function extractAccountSpecs(canvas: CanvasSnapshot): AccountSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const secretType = fields.secret_type === 'key' ? 'key' : 'password'
    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      safeName: typeof fields.safe_name === 'string' ? fields.safe_name.trim() : '',
      platformId: typeof fields.platform_id === 'string' ? fields.platform_id.trim() : '',
      address: typeof fields.address === 'string' ? fields.address.trim() : '',
      userName: typeof fields.user_name === 'string' ? fields.user_name.trim() : '',
      secretType,
      // Only surrounding whitespace is trimmed; the value is never logged or surfaced.
      secret: typeof fields.secret === 'string' ? fields.secret.trim() : '',
      platformPropertiesJson: typeof fields.platform_account_properties === 'string' ? fields.platform_account_properties : '',
      automaticManagementEnabled: readBool(fields.automatic_management_enabled, true),
      manualManagementReason: typeof fields.manual_management_reason === 'string' ? fields.manual_management_reason.trim() : '',
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate account configurations: name, safe and platform id are required; the
 * platform-properties field must parse to a JSON object; a manual-management
 * reason is required when automatic management is off; and the (name, safe)
 * natural key is unique. The secret is write-only and is never inspected beyond
 * an (optional) presence note.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractAccountSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Account name is required', code: 'required' })
    }
    if (!spec.safeName) {
      errors.push({ field: `${prefix}.safe_name`, message: 'Safe name is required', code: 'required' })
    }
    if (!spec.platformId) {
      errors.push({ field: `${prefix}.platform_id`, message: 'Platform ID is required', code: 'required' })
    }
    if (!SECRET_TYPES.includes(spec.secretType)) {
      errors.push({ field: `${prefix}.secret_type`, message: `Unsupported secret type "${spec.secretType}"`, code: 'invalid_secret_type' })
    }

    if (spec.platformPropertiesJson.trim()) {
      const parsed = parseJsonObject(spec.platformPropertiesJson)
      if (parsed.error) {
        errors.push({ field: `${prefix}.platform_account_properties`, message: `Platform properties ${parsed.error}`, code: 'invalid_json' })
      }
    }

    if (!spec.automaticManagementEnabled && !spec.manualManagementReason) {
      errors.push({
        field: `${prefix}.manual_management_reason`,
        message: 'A manual-management reason is required when automatic management is disabled',
        code: 'required',
      })
    }

    if (spec.name && spec.safeName) {
      const key = accountKey(spec)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate account "${spec.name}" in safe "${spec.safeName}" — each (name, safe) may only be declared once`,
          code: 'duplicate_account',
        })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}

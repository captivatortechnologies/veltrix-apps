import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { parseJsonObject, parsePositiveInt, readStringList } from '../../lib/cyberark'

// =============================================================================
// CyberArk Vault Users — validate + shared spec extraction.
//
// A Vault user is a CyberArk identity (distinct from a directory/LDAP user
// mapped in via cyberark-directory-mappings). CyberArk assigns a numeric id,
// so reconciliation uses the natural key: username.
//
// ⚠ WRITE-ONLY SECRET. Each item may carry an `initial_password`. CyberArk
// NEVER returns it on read. This app therefore sends it ONLY when CREATING a
// user; it is never read back, diffed, or stored in rollbackData / artifacts
// / logs (mirrors the cyberark-accounts secret rule exactly). Resetting an
// EXISTING user's password (`POST /Users/{id}/ResetPassword`) is intentionally
// NOT exposed by this type — this app never manages credential rotation.
// =============================================================================

export interface VaultUserSpec {
  sectionName: string
  username: string
  userType: string
  description: string
  location: string
  /** ⚠ Write-only. Sent only on create; never read/diffed/stored. */
  initialPassword: string
  authenticationMethod: string[]
  vaultAuthorization: string[]
  unauthorizedInterfaces: string[]
  enableUser: boolean
  changePassOnNextLogon: boolean
  passwordNeverExpires: boolean
  expiryDate: number | null
  /** Raw JSON merging businessAddress/internet/phones/personalDetails. */
  contactDetailsJson: string
}

/** Shape of a Vault user returned by GET /Users/{id} (only non-secret fields we manage). */
export interface LiveVaultUser {
  id?: string | number
  username?: string
  userType?: string
  description?: string
  location?: string
  authenticationMethod?: string[]
  vaultAuthorization?: string[]
  unAuthorizedInterfaces?: string[]
  enableUser?: boolean
  changePassOnNextLogon?: boolean
  passwordNeverExpires?: boolean
  expiryDate?: number
  businessAddress?: Record<string, unknown>
  internet?: Record<string, unknown>
  phones?: Record<string, unknown>
  personalDetails?: Record<string, unknown>
}

/** A user's natural key — its username, lower-cased for reconciliation. */
export function usernameKey(spec: { username: string }): string {
  return spec.username.trim().toLowerCase()
}

function readBool(value: unknown, fallback: boolean): boolean {
  if (value === true || value === 'true') return true
  if (value === false || value === 'false') return false
  return fallback
}

/** Each canvas item describes one Vault user. */
export function extractVaultUserSpecs(canvas: CanvasSnapshot): VaultUserSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      username: typeof fields.username === 'string' ? fields.username.trim() : '',
      userType: typeof fields.user_type === 'string' && fields.user_type.trim() ? fields.user_type.trim() : 'EPVUser',
      description: typeof fields.description === 'string' ? fields.description.trim() : '',
      location: typeof fields.location === 'string' && fields.location.trim() ? fields.location.trim() : '\\',
      // Only surrounding whitespace is trimmed; the value is never logged or surfaced.
      initialPassword: typeof fields.initial_password === 'string' ? fields.initial_password.trim() : '',
      authenticationMethod: readStringList(fields.authentication_method),
      vaultAuthorization: readStringList(fields.vault_authorization),
      unauthorizedInterfaces: readStringList(fields.unauthorized_interfaces),
      enableUser: readBool(fields.enable_user, true),
      changePassOnNextLogon: readBool(fields.change_pass_on_next_logon, false),
      passwordNeverExpires: readBool(fields.password_never_expires, false),
      expiryDate: parsePositiveInt(fields.expiry_date).value,
      contactDetailsJson: typeof fields.contact_details === 'string' ? fields.contact_details : '',
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate Vault user configurations: username is required and unique; the
 * contact-details JSON (when set) must parse to a JSON object; the expiry
 * date (when set) is a positive epoch. The initial password is write-only
 * and is never inspected beyond an implicit presence check downstream.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractVaultUserSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.username) errors.push({ field: `${prefix}.username`, message: 'Username is required', code: 'required' })

    if (spec.contactDetailsJson.trim()) {
      const parsed = parseJsonObject(spec.contactDetailsJson)
      if (parsed.error) {
        errors.push({ field: `${prefix}.contact_details`, message: `Contact details ${parsed.error}`, code: 'invalid_json' })
      }
    }

    const expiry = parsePositiveInt((sections.find((s) => s.name === prefix)?.fields ?? {}).expiry_date)
    if (expiry.error) {
      errors.push({ field: `${prefix}.expiry_date`, message: `Expiry date ${expiry.error} (Unix epoch seconds)`, code: 'invalid_expiry' })
    }

    if (spec.username) {
      const key = usernameKey(spec)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.username`,
          message: `Duplicate username "${spec.username}" — each username may only be declared once`,
          code: 'duplicate_user',
        })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
